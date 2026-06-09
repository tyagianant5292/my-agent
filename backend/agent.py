"""Agent loop: model se poochho -> tool maange to chalao -> wapas do ->
jab tak final text jawab na mile."""
from __future__ import annotations

import json
import sys

from tools import TOOLS, TOOL_FUNCTIONS

MAX_STEPS = 6


def run_agent(client, model: str, messages: list[dict]) -> str:
    for _ in range(MAX_STEPS):
        response = client.chat.completions.create(
            model=model,
            messages=messages,
            tools=TOOLS,
        )
        msg = response.choices[0].message

        # Koi tool nahi maanga -> yeh final jawab hai
        if not msg.tool_calls:
            return msg.content or ""

        # Tool calls process karo, results wapas messages me daalo
        messages.append(msg.model_dump(exclude_none=True))
        for call in msg.tool_calls:
            name = call.function.name
            args = json.loads(call.function.arguments or "{}")
            func = TOOL_FUNCTIONS.get(name)
            try:
                result = func(**args) if func else f"Unknown tool: {name}"
            except Exception as e:
                result = f"Tool error: {e}"
            print(f"[agent] tool={name} args={args} -> {str(result)[:120]}", file=sys.stderr)
            messages.append({
                "role": "tool",
                "tool_call_id": call.id,
                "content": str(result),
            })

    return "(Max steps tak pahunch gaye — jawab adhura ho sakta hai.)"
