"""FastAPI backend — agent ko HTTP API ke roop me expose karta hai.

Local run:
    pip install -r requirements.txt
    cp .env.example .env   # fir .env me API_KEY daalo
    uvicorn main:app --reload
"""
from __future__ import annotations

import os
import uuid
from contextlib import asynccontextmanager
from typing import Optional

from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from openai import OpenAI
from pydantic import BaseModel

import db
from agent import run_agent

load_dotenv()

API_KEY = os.getenv("API_KEY")
BASE_URL = os.getenv("BASE_URL", "https://api.openai.com/v1")
MODEL = os.getenv("MODEL", "gpt-4o-mini")
STT_MODEL = os.getenv("STT_MODEL", "whisper-large-v3-turbo")

SYSTEM_PROMPT = (
    "Tum ek helpful assistant ho. Zarurat padne par diye gaye tools ka use karo. "
    "Hindi/Hinglish me jawab do agar user usi me baat kare."
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

    reply = run_agent(client, MODEL, messages)

    # Sirf user + final assistant text store karte hain (clean history).
    db.save_message(conv_id, "user", req.message)
    db.save_message(conv_id, "assistant", reply)

    return ChatResponse(conversation_id=conv_id, reply=reply)
