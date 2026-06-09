"""FastAPI backend — agent ko HTTP API ke roop me expose karta hai.

Local run:
    pip install -r requirements.txt
    cp .env.example .env   # fir .env me API_KEY daalo
    uvicorn main:app --reload
"""
from __future__ import annotations

import os
import re
import uuid
from contextlib import asynccontextmanager
from typing import Optional

from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from openai import OpenAI, RateLimitError
from pydantic import BaseModel

import db
from agent import run_agent

load_dotenv()

API_KEY = os.getenv("API_KEY")
BASE_URL = os.getenv("BASE_URL", "https://api.openai.com/v1")
MODEL = os.getenv("MODEL", "gpt-4o-mini")
STT_MODEL = os.getenv("STT_MODEL", "whisper-large-v3-turbo")

SYSTEM_PROMPT = (
    "You are 'Tyagi', Anant's personal voice assistant (a Jarvis-style AI). "
    "Respond in ENGLISH by default. Only switch to Hindi/Hinglish if the user speaks "
    "Hindi or Hinglish, then reply in that same language. "
    "Keep replies short, clear and natural — they are read aloud, so avoid markdown, "
    "lists, emojis and long paragraphs. "
    "Use the available tools when helpful: calculator, current_time, draft_email, send_email.\n"
    "EMAIL RULES (follow strictly):\n"
    "1. ALWAYS write the email itself — both the subject and the body — in ENGLISH by default, "
    "even when the user is speaking Hindi or Hinglish. Only write the email in Hindi if the user "
    "EXPLICITLY asks for the draft/email in Hindi. Your spoken replies and the confirmation can "
    "still be in the user's language, but the email content stays English unless they ask otherwise.\n"
    "2. Compose a clear, professional, complete email. Expand the user's short instruction into a "
    "proper message with a greeting and sign-off (sign off as Anant Kumar unless told otherwise).\n"
    "3. Make sure you know the recipient's email address, the subject, and the message. Ask short "
    "follow-up questions for anything missing. If the recipient's email address sounds unclear or "
    "looks malformed (this is common when it is spoken aloud), ask the user to confirm or spell it "
    "out letter by letter BEFORE drafting — do not guess the address.\n"
    "4. When you have everything, call draft_email, then read the draft BACK to the user (recipient, "
    "subject, and the full message) and ask them to confirm.\n"
    "5. Call send_email ONLY after the user clearly confirms (yes / send it / haan bhej do). "
    "Never send without explicit confirmation. If the user wants changes, draft again.\n"
    "6. Report the REAL outcome of send_email truthfully. Only say the email was sent if the "
    "tool result confirms success. If the result starts with NOT_SENT or mentions an error, "
    "tell the user it was NOT sent and why — never pretend it was sent."
)

client = OpenAI(api_key=API_KEY, base_url=BASE_URL) if API_KEY else None


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init_db()
    yield


app = FastAPI(title="My Agent API", lifespan=lifespan)

# Frontend (Vercel) ko backend call karne dene ke liye CORS.
# Production me ALLOWED_ORIGINS me apne Vercel URL daalo.
origins = os.getenv("ALLOWED_ORIGINS", "*").split(",")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in origins],
    allow_methods=["*"],
    allow_headers=["*"],
)


class ChatRequest(BaseModel):
    message: str
    conversation_id: Optional[str] = None


class ChatResponse(BaseModel):
    conversation_id: str
    reply: str
    retry_after: Optional[float] = None  # seconds until rate limit frees up


def _retry_after_seconds(err) -> Optional[float]:
    """RateLimitError se nikalta hai ki kitne seconds baad dobara try karein."""
    # 1) Standard retry-after header (Groq isse bhejta hai).
    try:
        headers = err.response.headers
        ra = headers.get("retry-after")
        if ra:
            return float(ra)
        ra_ms = headers.get("retry-after-ms")
        if ra_ms:
            return float(ra_ms) / 1000
    except Exception:  # noqa: BLE001
        pass
    # 2) Fallback: message se parse karo, e.g. "try again in 13m1.92s".
    text = str(getattr(err, "message", "") or err)
    m = re.search(r"try again in\s+(?:(\d+)m)?\s*([\d.]+)s", text)
    if m:
        mins = int(m.group(1) or 0)
        secs = float(m.group(2) or 0)
        return mins * 60 + secs
    return None


@app.get("/api/health")
def health():
    return {"status": "ok", "model": MODEL, "db": db.enabled()}


@app.post("/api/transcribe")
async def transcribe(file: UploadFile = File(...), language: Optional[str] = Form(None)):
    """Audio (webm/wav/...) ko Groq Whisper se text me badalta hai (Speech-to-Text)."""
    if client is None:
        raise HTTPException(status_code=500, detail="API_KEY set nahi hai.")

    audio_bytes = await file.read()
    try:
        result = client.audio.transcriptions.create(
            model=STT_MODEL,
            file=(file.filename or "audio.webm", audio_bytes),
            language=language or None,
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Transcription fail: {e}")

    return {"text": result.text}


@app.post("/api/chat", response_model=ChatResponse)
def chat(req: ChatRequest):
    if client is None:
        raise HTTPException(status_code=500, detail="API_KEY set nahi hai (backend env me daalo).")

    conv_id = req.conversation_id or str(uuid.uuid4())

    history = db.load_messages(conv_id)
    messages = [{"role": "system", "content": SYSTEM_PROMPT}, *history]
    messages.append({"role": "user", "content": req.message})

    try:
        reply = run_agent(client, MODEL, messages)
    except RateLimitError as e:
        # Free Groq tier limit — friendly note + when it'll work again (no crash).
        return ChatResponse(
            conversation_id=conv_id,
            reply="⚠️ I've reached the free AI usage limit right now.",
            retry_after=_retry_after_seconds(e),
        )
    except Exception as e:  # noqa: BLE001
        return ChatResponse(conversation_id=conv_id, reply=f"⚠️ Something went wrong: {e}")

    # Sirf user + final assistant text store karte hain (clean history).
    db.save_message(conv_id, "user", req.message)
    db.save_message(conv_id, "assistant", reply)

    return ChatResponse(conversation_id=conv_id, reply=reply)
