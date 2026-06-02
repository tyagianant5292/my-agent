"""Agent ke tools. Naya tool add karne ke liye:
1. Ek function likho.
2. Uska JSON schema TOOLS list me daalo.
3. TOOL_FUNCTIONS dict me naam -> function map karo.
"""
from __future__ import annotations

import ast
import datetime
import operator

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
]

TOOL_FUNCTIONS = {
    "calculator": calculator,
    "current_time": current_time,
}
