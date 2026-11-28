"""Version ordering for the installer and release tooling."""

from __future__ import annotations


def _ver_tuple(ver_str: str) -> tuple[int | str, ...]:
    """Parse version string like '1.1.0-beta.1' into comparable tuple.

    Pre-release segments sort BEFORE release: '1.0.0-beta' < '1.0.0'.
    Strategy: pre-release gets empty tuple appended; release gets (1,) appended.
    This makes (1, 0, 0) < (1, 0, 0, 1) because tuple comparison is lexicographic.

    Examples:
    - '1.1.0' → (1, 1, 0, 1)  # release
    - '1.1.0-beta.1' → (1, 1, 0, 0, 'beta', 1)  # pre-release sorts first
    - '1.1.0-rc.2' → (1, 1, 0, 0, 'rc', 2)  # pre-release sorts first
    """
    if not ver_str or not isinstance(ver_str, str):
        return ()

    if "-" not in ver_str:
        # Release version: base numbers + (1,) to sort AFTER pre-release
        try:
            base = tuple(int(x) for x in ver_str.split("."))
            return base + (1,)
        except (ValueError, AttributeError):
            return ()

    # Pre-release: split on "-"
    parts = ver_str.split("-", 1)
    try:
        base = tuple(int(x) for x in parts[0].split("."))
    except (ValueError, AttributeError):
        return ()

    # Pre-release identifier: (0,) prefix sorts before release's (1,)
    pre_part = parts[1] if len(parts) > 1 else ""
    pre_tokens = [0]  # 0 sorts before 1
    for token in pre_part.split("."):
        try:
            pre_tokens.append(int(token))
        except ValueError:
            pre_tokens.append(token)

    return base + tuple(pre_tokens)
