"""Validation and matching for policy glob conditions."""

from __future__ import annotations

import re


class PolicyPatternError(ValueError):
    """A policy condition contains an invalid glob pattern."""


def compile_glob(pattern: str) -> re.Pattern[str]:
    """Compile the supported policy glob syntax.

    ``*`` matches zero or more non-separator characters and ``?`` matches
    exactly one. Character classes use ``[abc]``, ``[a-z]``, or ``[!abc]``;
    unlike wildcards, a character class can explicitly match ``/``.
    """
    if not isinstance(pattern, str):
        raise PolicyPatternError("glob pattern must be a string")

    parts: list[str] = []
    index = 0
    while index < len(pattern):
        char = pattern[index]
        if char == "*":
            parts.append("[^/]*")
        elif char == "?":
            parts.append("[^/]")
        elif char == "[":
            end = pattern.find("]", index + 1)
            if end == -1:
                raise PolicyPatternError("unclosed character class")

            contents = pattern[index + 1 : end]
            negated = contents.startswith("!")
            members = contents[1:] if negated else contents
            if not members:
                raise PolicyPatternError("empty character class")

            class_members = "".join(
                "\\\\"
                if member == "\\"
                else "\\^"
                if member == "^"
                else "\\["
                if member == "["
                else member
                for member in members
            )
            character_class = f"[{'^' if negated else ''}{class_members}]"
            try:
                re.compile(character_class)
            except re.error as exc:
                raise PolicyPatternError(
                    f"invalid character class: {exc}"
                ) from exc
            parts.append(character_class)
            index = end
        else:
            parts.append(re.escape(char))
        index += 1

    try:
        return re.compile("".join(parts))
    except re.error as exc:
        raise PolicyPatternError(f"invalid glob pattern: {exc}") from exc
