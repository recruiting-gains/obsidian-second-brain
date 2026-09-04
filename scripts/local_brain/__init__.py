"""Local-first ingestion and vault safety helpers for Cruz's AI second brain."""

from .core import GENERATED_END, GENERATED_START, USER_END, USER_START, BrainError

__all__ = [
    "BrainError",
    "GENERATED_END",
    "GENERATED_START",
    "USER_END",
    "USER_START",
]
