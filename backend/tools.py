"""Agent ke tools. Naya tool add karne ke liye:
1. Ek function likho.
2. Uska JSON schema TOOLS list me daalo.
3. TOOL_FUNCTIONS dict me naam -> function map karo.
"""
from __future__ import annotations

import ast
import datetime
import operator
import os
import re
import smtplib
import ssl
from email.message import EmailMessage

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

_ALLOWED_OPS = {
    ast.Add: operator.add,
    ast.Sub: operator.sub,
    ast.Mult: operator.mul,
    ast.Div: operator.truediv,
    ast.Pow: operator.pow,
    ast.Mod: operator.mod,
    ast.USub: operator.neg,
}


def _safe_eval(node):
    if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
        return node.value
    if isinstance(node, ast.BinOp) and type(node.op) in _ALLOWED_OPS:
        return _ALLOWED_OPS[type(node.op)](_safe_eval(node.left), _safe_eval(node.right))
    if isinstance(node, ast.UnaryOp) and type(node.op) in _ALLOWED_OPS:
        return _ALLOWED_OPS[type(node.op)](_safe_eval(node.operand))
    raise ValueError("Sirf simple arithmetic allowed hai")


def calculator(expression: str) -> str:
    """Safe calculator — sirf +, -, *, /, **, % allowed (eval ka use nahi)."""
    tree = ast.parse(expression, mode="eval")
    return str(_safe_eval(tree.body))


def current_time() -> str:
    return datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def draft_email(to: str, subject: str, body: str) -> str:
    """Email DRAFT banata hai (bhejta NAHI). Confirm flow ke liye pehla step.
    Recipient email validate karta hai."""
    to = (to or "").strip()
    if not _EMAIL_RE.match(to):
        return (
            f"Invalid recipient address: '{to}'. Ask the user for a valid email "
            "address before drafting."
        )
    subject = (subject or "").strip() or "(no subject)"
    body = (body or "").strip()
    if not body:
        return "The email body is empty. Ask the user what the message should say."
    return (
        "DRAFT READY (not sent yet). Read this back to the user verbatim and ask "
        "for confirmation before calling send_email.\n"
        f"To: {to}\nSubject: {subject}\n\n{body}"
    )


def send_email(to: str, subject: str, body: str) -> str:
    """Email actually bhejta hai (Gmail SMTP). Sirf user ke confirm karne ke baad call karo."""
    to = (to or "").strip()
    if not _EMAIL_RE.match(to):
        return f"Invalid recipient address: '{to}'. Cannot send."

    host = os.getenv("SMTP_HOST", "smtp.gmail.com")
    port = int(os.getenv("SMTP_PORT", "587"))
    user = os.getenv("SMTP_USER")
    pw = os.getenv("SMTP_PASS")
    sender = os.getenv("MAIL_FROM") or user

    if not user or not pw:
        return (
            "NOT_SENT: The email was NOT sent because email sending is not configured yet "
            "(the Gmail App Password is missing). You MUST tell the user the email was NOT "
            "sent, and that it will actually send once the password is added. Do not claim "
            "it was sent."
        )

    msg = EmailMessage()
    msg["From"] = sender
    msg["To"] = to
    msg["Subject"] = (subject or "").strip() or "(no subject)"
    msg.set_content((body or "").strip())

    try:
        with smtplib.SMTP(host, port, timeout=20) as server:
            server.starttls(context=ssl.create_default_context())
            server.login(user, pw)
            server.send_message(msg)
    except Exception as e:  # noqa: BLE001
        return f"Failed to send email: {e}"
    return f"Email sent successfully to {to}."


TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "calculator",
            "description": "Math expression evaluate karta hai, jaise '12 * (3 + 4)'.",
            "parameters": {
                "type": "object",
                "properties": {
                    "expression": {"type": "string", "description": "Arithmetic expression"}
                },
                "required": ["expression"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "current_time",
            "description": "Abhi ki date aur time batata hai.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "draft_email",
            "description": (
                "Prepare an email draft WITHOUT sending it. Always call this first when "
                "the user wants to send an email, once you know the recipient, subject and "
                "body. Returns the draft to read back to the user for confirmation."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "to": {"type": "string", "description": "Recipient email address"},
                    "subject": {"type": "string", "description": "Email subject line"},
                    "body": {"type": "string", "description": "Full email body text"},
                },
                "required": ["to", "subject", "body"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "send_email",
            "description": (
                "Actually send the email. ONLY call this AFTER the user has explicitly "
                "confirmed the draft (e.g. said yes / send it / haan bhej do)."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "to": {"type": "string", "description": "Recipient email address"},
                    "subject": {"type": "string", "description": "Email subject line"},
                    "body": {"type": "string", "description": "Full email body text"},
                },
                "required": ["to", "subject", "body"],
            },
        },
    },
]

TOOL_FUNCTIONS = {
    "calculator": calculator,
    "current_time": current_time,
    "draft_email": draft_email,
    "send_email": send_email,
}
