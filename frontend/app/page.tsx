"use client";

import { useEffect, useRef, useState } from "react";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

// --- Voice Activity Detection (VAD) tuning ---
const SPEECH_START = 0.05;
const SILENCE = 0.025;
const SILENCE_MS = 1200;
const NO_SPEECH_MS = 6000;
const MAX_MS = 20000;

// Wake phrase matcher — lenient for STT variants of "Hey Tyagi".
// Greeting is optional; the distinctive "tyagi"-like name core is required.
const WAKE_RE = /\b(?:hey|hay|hi|ok|okay|ay|a)?\s*(?:t[hy]?i?yagi|tyagee|tyaji|tiagi|tyagy)\b/i;

// Common Whisper hallucinations on silence/near-silence — never send these.
const HALLUCINATIONS = new Set([
  "you", "thankyou", "thanks", "thanksforwatching", "thankyouforwatching",
  "okay", "ok", "bye", "byebye", "please", "subscribe", "pleasesubscribe",
  "ididnthearyourvoice", "ididnthearyou", "uh", "um", "hmm", "ah", "oh", "so",
]);

type Message = { role: "user" | "assistant"; content: string };
type Status = "idle" | "wake" | "listening" | "transcribing" | "thinking" | "speaking";

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [power, setPower] = useState(false);
  const [lang, setLang] = useState("en-IN");
  const [micOk, setMicOk] = useState(true);
  const [wakeOk, setWakeOk] = useState(true);

  const endRef = useRef<HTMLDivElement>(null);
  const orbRef = useRef<HTMLDivElement>(null);
  const powerRef = useRef(false);
  const activeRef = useRef(false);
  const langRef = useRef(lang);
  const conversationIdRef = useRef<string | null>(null);

  const mediaStreamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);

  const recRef = useRef<any>(null);
  const recOnRef = useRef(false);

  useEffect(() => { powerRef.current = power; }, [power]);
  useEffect(() => { langRef.current = lang; }, [lang]);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, status]);

  // Restore the conversation across refreshes (backend keeps history by id in Neon).
  useEffect(() => {
    try {
      const cid = localStorage.getItem("tyagi_conv_id");
      if (cid) conversationIdRef.current = cid;
      const saved = localStorage.getItem("tyagi_messages");
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) setMessages(parsed);
      }
    } catch {
      /* ignore */
    }
  }, []);

  // Persist the visible transcript so a refresh recalls the same chat.
  useEffect(() => {
    try {
      const toSave = messages.filter((m) => m.content && m.content !== "…");
      if (toSave.length) localStorage.setItem("tyagi_messages", JSON.stringify(toSave.slice(-100)));
    } catch {
      /* ignore */
    }
  }, [messages]);

  useEffect(() => {
    const hasMedia =
      typeof navigator !== "undefined" &&
      !!navigator.mediaDevices &&
      typeof window.MediaRecorder !== "undefined";
    if (!hasMedia) setMicOk(false);
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) setWakeOk(false);
    // Warm up the free-tier backend so it's awake by the time the user talks.
    fetch(`${API_URL}/api/health`).catch(() => {});
  }, []);

  // ---------- helpers ----------
  function setLastAssistant(content: string) {
    setMessages((m) => {
      const copy = [...m];
      for (let i = copy.length - 1; i >= 0; i--) {
        if (copy[i].role === "assistant") {
          copy[i] = { ...copy[i], content };
          break;
        }
      }
      return copy;
    });
  }

  // Retries through free-tier cold starts (network errors / 502-504) instead of
  // failing instantly with "Failed to fetch".
  async function fetchWithRetry(
    url: string,
    opts: RequestInit,
    onRetry?: (attempt: number) => void,
    tries = 15,
    delay = 4000,
  ): Promise<Response> {
    let lastErr: unknown;
    for (let i = 0; i < tries; i++) {
      try {
        const res = await fetch(url, opts);
        if (res.status >= 502 && res.status <= 504) throw new Error(`server ${res.status}`);
        return res;
      } catch (e) {
        lastErr = e;
        if (i < tries - 1) {
          onRetry?.(i);
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error("Failed to fetch");
  }

  function speak(text: string): Promise<void> {
    return new Promise((resolve) => {
      const synth = typeof window !== "undefined" ? window.speechSynthesis : undefined;
      if (!synth || !text) return resolve();
      try {
        synth.cancel();
      } catch {
        /* ignore */
      }
      let done = false;
      let watch: ReturnType<typeof setTimeout>;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(watch);
        resolve();
      };
      const u = new SpeechSynthesisUtterance(text);
      u.lang = langRef.current;
      const match = synth.getVoices().find((v) => v.lang === langRef.current);
      if (match) u.voice = match;
      u.onend = finish;
      u.onerror = finish;
      // Failsafe: Chrome sometimes never fires onend — resolve after an estimate
      // so the assistant never gets stuck on "speaking".
      watch = setTimeout(finish, Math.min(16000, 1500 + text.length * 80));
      // tiny delay after cancel() + resume() avoids a known Chrome stuck-speech bug
      setTimeout(() => {
        try {
          synth.resume();
          synth.speak(u);
        } catch {
          finish();
        }
      }, 70);
    });
  }

  function chime() {
    try {
      const Ctx = window.AudioContext || (window as any).webkitAudioContext;
      const ctx = new Ctx();
      const now = ctx.currentTime;
      [880, 1320].forEach((f, i) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.frequency.value = f;
        o.type = "sine";
        o.connect(g);
        g.connect(ctx.destination);
        const t = now + i * 0.09;
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(0.15, t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
        o.start(t);
        o.stop(t + 0.2);
      });
      setTimeout(() => ctx.close().catch(() => {}), 500);
    } catch {
      /* ignore */
    }
  }

  function cleanupAudio() {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    orbRef.current?.style.setProperty("--amp", "0");
    mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
    mediaStreamRef.current = null;
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
  }

  function stopRecording() {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    const rec = mediaRecorderRef.current;
    if (rec && rec.state === "recording") rec.stop();
  }

  // ---------- wake-word listening ----------
  function startWake() {
    setStatus("wake");
    if (!wakeOk) return; // no SpeechRecognition — user taps the orb instead
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) return;
    if (recOnRef.current) return;
    const rec = new SR();
    rec.lang = "en-IN";
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (e: any) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const txt = e.results[i][0].transcript as string;
        if (WAKE_RE.test(txt)) {
          onWake();
          return;
        }
      }
    };
    rec.onerror = (e: any) => {
      // Permission errors are fatal; everything else (no-speech, network, aborted)
      // is recoverable and onend will restart us.
      if (e?.error === "not-allowed" || e?.error === "service-not-allowed") {
        setWakeOk(false);
      }
    };
    rec.onend = () => {
      recOnRef.current = false;
      // auto-restart while powered and not in a command session
      if (powerRef.current && !activeRef.current) {
        setTimeout(() => startWake(), 250);
      }
    };
    recRef.current = rec;
    try {
      rec.start();
      recOnRef.current = true;
    } catch {
      recOnRef.current = false;
    }
  }

  function stopWake() {
    const rec = recRef.current;
    recOnRef.current = false;
    if (rec) {
      rec.onend = null;
      try { rec.stop(); } catch { /* ignore */ }
      try { rec.abort(); } catch { /* ignore */ }
    }
    recRef.current = null;
  }

  async function onWake() {
    if (activeRef.current) return;
    stopWake();
    activeRef.current = true;
    chime();
    setStatus("speaking");
    await speak(langRef.current.startsWith("hi") ? "Haan, boliye." : "Yes?");
    // small gap so the greeting audio clears the mic before we start recording
    await new Promise((r) => setTimeout(r, 400));
    if (activeRef.current) startRecording();
  }

  function exitActive() {
    activeRef.current = false;
    stopRecording();
    cleanupAudio();
    if (powerRef.current) startWake();
    else setStatus("idle");
  }

  // ---------- command recording (VAD) ----------
  async function startRecording() {
    if (!activeRef.current) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;

      const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : MediaRecorder.isTypeSupported("audio/webm")
          ? "audio/webm"
          : "";
      const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      mediaRecorderRef.current = rec;

      const chunks: BlobPart[] = [];
      let speechDetected = false;

      rec.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
      rec.onstop = async () => {
        cleanupAudio();
        if (!activeRef.current) return;
        if (!speechDetected) { exitActive(); return; } // silence -> sleep
        const blob = new Blob(chunks, { type: mime || "audio/webm" });
        await transcribeAndSend(blob);
      };

      rec.start();
      setStatus("listening");

      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      const audioCtx = new AudioCtx();
      audioCtxRef.current = audioCtx;
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);
      const data = new Uint8Array(analyser.fftSize);

      const startedAt = Date.now();
      let lastVoiceAt = Date.now();

      const tick = () => {
        const r = mediaRecorderRef.current;
        if (!r || r.state !== "recording") return;
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
          const a = (data[i] - 128) / 128;
          sum += a * a;
        }
        const rms = Math.sqrt(sum / data.length);
        orbRef.current?.style.setProperty("--amp", Math.min(0.6, rms * 3).toFixed(3));
        const now = Date.now();
        if (rms > SPEECH_START) { speechDetected = true; lastVoiceAt = now; }
        else if (rms > SILENCE) { lastVoiceAt = now; }

        const elapsed = now - startedAt;
        const silenceFor = now - lastVoiceAt;
        if (speechDetected && silenceFor > SILENCE_MS) return stopRecording();
        if (!speechDetected && elapsed > NO_SPEECH_MS) return stopRecording();
        if (elapsed > MAX_MS) return stopRecording();
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    } catch (err) {
      activeRef.current = false;
      cleanupAudio();
      if (powerRef.current) startWake();
      else setStatus("idle");
      alert("Mic error: " + (err as Error).message);
    }
  }

  async function transcribeAndSend(blob: Blob) {
    setStatus("transcribing");
    try {
      const fd = new FormData();
      fd.append("file", blob, "audio.webm");
      fd.append("language", langRef.current.startsWith("hi") ? "hi" : "en");
      const res = await fetchWithRetry(`${API_URL}/api/transcribe`, { method: "POST", body: fd });
      if (!res.ok) throw new Error(`Transcribe error: ${res.status}`);
      const { text } = await res.json();
      const cleaned = (text || "").trim();
      const norm = cleaned.toLowerCase().replace(/[^a-z0-9ऀ-ॿ]/g, "");
      // Drop empty / too-short / known-hallucination transcripts (silence noise).
      if (!cleaned || norm.length < 2 || HALLUCINATIONS.has(norm)) {
        exitActive();
        return;
      }
      await sendMessage(cleaned, true);
    } catch (err) {
      setMessages((m) => [...m, { role: "assistant", content: `⚠️ ${(err as Error).message}` }]);
      exitActive();
    }
  }

  async function sendMessage(text: string, spoken: boolean) {
    const trimmed = text.trim();
    if (!trimmed) return;
    setMessages((m) => [
      ...m,
      { role: "user", content: trimmed },
      { role: "assistant", content: "…" },
    ]);
    setInput("");
    setStatus("thinking");

    let reply = "";
    try {
      const res = await fetchWithRetry(
        `${API_URL}/api/chat`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: trimmed, conversation_id: conversationIdRef.current }),
        },
        (attempt) =>
          setLastAssistant(`🟡 Waking the assistant… (free hosting cold start ~${(attempt + 1) * 4}s)`),
      );
      if (!res.ok) throw new Error(`Server error ${res.status}`);
      const data = await res.json();
      conversationIdRef.current = data.conversation_id;
      try {
        localStorage.setItem("tyagi_conv_id", data.conversation_id);
      } catch {
        /* ignore */
      }
      reply = data.reply;
      if (data.retry_after) {
        const secs = Math.ceil(data.retry_after);
        const mins = Math.ceil(secs / 60);
        const at = new Date(Date.now() + secs * 1000);
        const t = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        const when = secs < 90 ? `${secs} seconds` : `about ${mins} minute${mins > 1 ? "s" : ""}`;
        reply += `\n\n⏳ Try again in ${when} — around ${t} your time.`;
      }
      setLastAssistant(reply);
    } catch {
      setLastAssistant(
        "⚠️ Couldn't reach the assistant. The free server may be asleep — please try again in a moment.",
      );
    }

    if (spoken && reply) {
      setStatus("speaking");
      await speak(reply);
    }

    // hands-free: after a spoken reply keep the session open for a follow-up
    if (spoken && activeRef.current && powerRef.current) {
      await new Promise((r) => setTimeout(r, 400)); // avoid catching our own TTS tail
      if (activeRef.current && powerRef.current) startRecording();
    } else if (spoken) {
      exitActive();
    } else {
      setStatus(powerRef.current ? "wake" : "idle");
    }
  }

  // ---------- controls ----------
  function togglePower() {
    if (power) {
      setPower(false);
      powerRef.current = false;
      activeRef.current = false;
      stopWake();
      stopRecording();
      cleanupAudio();
      window.speechSynthesis?.cancel();
      setStatus("idle");
    } else {
      setPower(true);
      powerRef.current = true;
      window.speechSynthesis?.getVoices();
      startWake();
    }
  }

  function newChat() {
    conversationIdRef.current = null;
    setMessages([]);
    try {
      localStorage.removeItem("tyagi_conv_id");
      localStorage.removeItem("tyagi_messages");
    } catch {
      /* ignore */
    }
  }

  // tap orb = talk now (skips wake word). If a session is stuck, tap resets it.
  function tapOrb() {
    if (activeRef.current) {
      // escape hatch: cancel a stuck/active session and go back to listening
      window.speechSynthesis?.cancel();
      activeRef.current = false;
      stopRecording();
      cleanupAudio();
      if (powerRef.current) startWake();
      else setStatus("idle");
      return;
    }
    if (!powerRef.current) {
      setPower(true);
      powerRef.current = true;
    }
    window.speechSynthesis?.getVoices();
    stopWake();
    onWake();
  }

  const caption: Record<Status, { big: string; sub: string; hint?: boolean }> = {
    idle: { big: "Standby", sub: "Tap the orb or press Activate" },
    wake: { big: 'Say "Hey Tyagi"', sub: "…or tap the orb to talk", hint: true },
    listening: { big: "Listening…", sub: "Speak now" },
    transcribing: { big: "Got it…", sub: "understanding" },
    thinking: { big: "Thinking…", sub: "working on it" },
    speaking: { big: "Speaking…", sub: "" },
  };
  const cap = caption[status];

  return (
    <div className="app">
      <div className="topbar">
        <span className="brand">
          <span className="dot">◆</span> TYAGI
        </span>
        <span className="statuspill">{power ? (status === "wake" ? "awake" : status) : "offline"}</span>
        <span className="spacer" />
        {messages.length > 0 && (
          <button className="newbtn" onClick={newChat} title="Start a new conversation">
            ＋ New
          </button>
        )}
        <div className="langtoggle">
          <button className={lang === "en-IN" ? "active" : ""} onClick={() => setLang("en-IN")}>EN</button>
          <button className={lang === "hi-IN" ? "active" : ""} onClick={() => setLang("hi-IN")}>हि</button>
        </div>
        <button className={`powerbtn ${power ? "on" : ""}`} onClick={togglePower} disabled={!micOk}>
          {power ? "● Online" : "Activate"}
        </button>
      </div>

      {!micOk && <div className="warn">⚠️ Voice needs a mic-enabled browser (Chrome/Edge). You can still type below.</div>}
      {micOk && !wakeOk && power && (
        <div className="warn">ℹ️ Wake word not supported here — tap the orb to talk.</div>
      )}

      <div className="stage">
        <div ref={orbRef} className={`orb ${status}`} onClick={tapOrb} title="Tap to talk">
          <div className="ring r1" />
          <div className="ring r2" />
          <div className="ring r3" />
          <div className="core" />
          <div className="bars">
            {Array.from({ length: 7 }).map((_, i) => (
              <span className="bar" key={i} />
            ))}
          </div>
        </div>
        <div className="caption">
          <div className={`big ${cap.hint ? "wake-hint" : ""}`}>{cap.big}</div>
          <div className="sub">{cap.sub}</div>
        </div>
      </div>

      {messages.length > 0 && (
        <div className="transcript">
          {messages.map((m, i) => (
            <div key={i} className={`msg ${m.role}`}>{m.content}</div>
          ))}
          <div ref={endRef} />
        </div>
      )}

      <div className="inputbar">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && sendMessage(input, false)}
          placeholder="Type a message…  (or say “Hey Tyagi”)"
        />
        <button onClick={() => sendMessage(input, false)} disabled={!input.trim() || status === "thinking"}>
          Send
        </button>
      </div>
    </div>
  );
}
