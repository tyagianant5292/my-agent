"use client";

import { useEffect, useRef, useState } from "react";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

// --- Voice Activity Detection (VAD) tuning — zarurat pade to badlo ---
const SPEECH_START = 0.05; // isse upar RMS = bol raha hai
const SILENCE = 0.025; // isse niche RMS = chup
const SILENCE_MS = 1200; // itni der chup -> recording stop
const NO_SPEECH_MS = 7000; // itni der me kuch na bola -> dobara suno
const MAX_MS = 20000; // safety: max recording length

type Message = { role: "user" | "assistant"; content: string };
type Status = "idle" | "listening" | "transcribing" | "thinking" | "speaking";

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [voiceOn, setVoiceOn] = useState(false);
  const [lang, setLang] = useState("en-IN");
  const [supported, setSupported] = useState(true);

  const endRef = useRef<HTMLDivElement>(null);
  const voiceOnRef = useRef(false);
  const langRef = useRef(lang);
  const conversationIdRef = useRef<string | null>(null);

  const mediaStreamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    voiceOnRef.current = voiceOn;
  }, [voiceOn]);
  useEffect(() => {
    langRef.current = lang;
  }, [lang]);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, status]);

  useEffect(() => {
    const hasMedia =
      typeof navigator !== "undefined" &&
      !!navigator.mediaDevices &&
      typeof window.MediaRecorder !== "undefined";
    if (!hasMedia) setSupported(false);
  }, []);

  // ---- Text-to-Speech: agent ka jawab bolna (browser) ----
  function speak(text: string): Promise<void> {
    return new Promise((resolve) => {
      if (typeof window.speechSynthesis === "undefined") return resolve();
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = langRef.current;
      const match = window.speechSynthesis
        .getVoices()
        .find((v) => v.lang === langRef.current);
      if (match) u.voice = match;
      u.onend = () => resolve();
      u.onerror = () => resolve();
      window.speechSynthesis.speak(u);
    });
  }

  function cleanupAudio() {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
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

  // ---- Mic se record karo + silence detect karke auto-stop ----
  async function startRecording() {
    if (!voiceOnRef.current) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;

      const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : MediaRecorder.isTypeSupported("audio/webm")
          ? "audio/webm"
          : "";
      const rec = mime
        ? new MediaRecorder(stream, { mimeType: mime })
        : new MediaRecorder(stream);
      mediaRecorderRef.current = rec;

      const chunks: BlobPart[] = [];
      let speechDetected = false;

      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };

      rec.onstop = async () => {
        cleanupAudio();
        if (!voiceOnRef.current) {
          setStatus("idle");
          return;
        }
        if (!speechDetected) {
          // Kuch bola hi nahi -> dobara suno
          setStatus("idle");
          setTimeout(() => voiceOnRef.current && startRecording(), 200);
          return;
        }
        const blob = new Blob(chunks, { type: mime || "audio/webm" });
        await transcribeAndSend(blob);
      };

      rec.start();
      setStatus("listening");

      // VAD: volume monitor karo
      const AudioCtx =
        window.AudioContext || (window as any).webkitAudioContext;
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
        const now = Date.now();
        if (rms > SPEECH_START) {
          speechDetected = true;
          lastVoiceAt = now;
        } else if (rms > SILENCE) {
          lastVoiceAt = now;
        }

        const elapsed = now - startedAt;
        const silenceFor = now - lastVoiceAt;

        if (speechDetected && silenceFor > SILENCE_MS) return stopRecording();
        if (!speechDetected && elapsed > NO_SPEECH_MS) return stopRecording();
        if (elapsed > MAX_MS) return stopRecording();
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    } catch (err) {
      setVoiceOn(false);
      voiceOnRef.current = false;
      setStatus("idle");
      cleanupAudio();
      alert("Mic nahi mila / permission denied: " + (err as Error).message);
    }
  }

  async function transcribeAndSend(blob: Blob) {
    setStatus("transcribing");
    try {
      const fd = new FormData();
      fd.append("file", blob, "audio.webm");
      fd.append("language", langRef.current.startsWith("hi") ? "hi" : "en");
      const res = await fetch(`${API_URL}/api/transcribe`, {
        method: "POST",
        body: fd,
      });
      if (!res.ok) throw new Error(`Transcribe error: ${res.status}`);
      const { text } = await res.json();
      if (!text || !text.trim()) {
        setStatus("idle");
        if (voiceOnRef.current) setTimeout(() => startRecording(), 200);
        return;
      }
      await sendMessage(text.trim(), true);
    } catch (err) {
      setMessages((m) => [
        ...m,
        { role: "assistant", content: `⚠️ ${(err as Error).message}` },
      ]);
      setStatus("idle");
      if (voiceOnRef.current)
        setTimeout(() => voiceOnRef.current && startRecording(), 600);
    }
  }

  async function sendMessage(text: string, speakReply: boolean) {
    const trimmed = text.trim();
    if (!trimmed) return;

    setMessages((m) => [...m, { role: "user", content: trimmed }]);
    setInput("");
    setStatus("thinking");

    try {
      const res = await fetch(`${API_URL}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: trimmed,
          conversation_id: conversationIdRef.current,
        }),
      });
      if (!res.ok) throw new Error(`Server error: ${res.status}`);
      const data = await res.json();
      conversationIdRef.current = data.conversation_id;
      setMessages((m) => [...m, { role: "assistant", content: data.reply }]);

      if (speakReply) {
        setStatus("speaking");
        await speak(data.reply);
      }
    } catch (err) {
      setMessages((m) => [
        ...m,
        { role: "assistant", content: `⚠️ Error: ${(err as Error).message}` },
      ]);
    } finally {
      setStatus("idle");
      // Hands-free: jawab bolne ke baad khud dobara suno
      if (speakReply && voiceOnRef.current) {
        setTimeout(() => voiceOnRef.current && startRecording(), 400);
      }
    }
  }

  function toggleVoice() {
    if (voiceOn) {
      setVoiceOn(false);
      voiceOnRef.current = false;
      stopRecording();
      cleanupAudio();
      window.speechSynthesis?.cancel();
      setStatus("idle");
    } else {
      setVoiceOn(true);
      voiceOnRef.current = true;
      window.speechSynthesis?.getVoices();
      startRecording();
    }
  }

  const statusLabel: Record<Status, string> = {
    idle: voiceOn ? "Voice mode on" : "",
    listening: "🎙️ Sun raha hu… (bolo)",
    transcribing: "✍️ Samajh raha hu…",
    thinking: "💭 Soch raha hu…",
    speaking: "🔊 Bol raha hu…",
  };

  return (
    <div className="chat">
      <div className="header">
        <h1>My Agent {voiceOn && <span className="jarvis">· JARVIS mode</span>}</h1>
        <select
          value={lang}
          onChange={(e) => setLang(e.target.value)}
          className="lang"
          title="Voice language"
        >
          <option value="en-IN">English</option>
          <option value="hi-IN">हिंदी</option>
        </select>
      </div>

      {!supported && (
        <div className="warn">
          ⚠️ Voice ke liye mic-enabled browser chahiye (Chrome/Edge/Firefox).
        </div>
      )}

      <div className="messages">
        {messages.length === 0 && (
          <div className="msg assistant">Namaste! Type karo ya 🎤 dabake bolo 👋</div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            {m.content}
          </div>
        ))}
        {status !== "idle" && (
          <div className={`status status-${status}`}>{statusLabel[status]}</div>
        )}
        <div ref={endRef} />
      </div>

      <div className="input-row">
        <button
          className={`mic ${voiceOn ? "on" : ""}`}
          onClick={toggleVoice}
          disabled={!supported}
          title={voiceOn ? "Voice band karo" : "Voice chalu karo"}
        >
          {voiceOn ? "⏹" : "🎤"}
        </button>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && sendMessage(input, false)}
          placeholder="Message likho…"
          disabled={status === "thinking"}
        />
        <button
          onClick={() => sendMessage(input, false)}
          disabled={status === "thinking" || !input.trim()}
        >
          Send
        </button>
      </div>
    </div>
  );
}
