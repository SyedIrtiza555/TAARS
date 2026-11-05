from pathlib import Path
import re

path = Path(__file__).resolve().parents[1] / "docs" / "guide" / "guide.html"
text = path.read_text(encoding="utf-8")
counter = 0


def replace(match: re.Match[str]) -> str:
    global counter
    counter += 1
    return f"{match.group(1)}{counter}{match.group(3)}"


text = re.sub(r'(<span class="fig">Figure )(\d+)(</span>)', replace, text)
path.write_text(text, encoding="utf-8")
print(f"Renumbered {counter} figures")
print(re.findall(r'<span class="fig">Figure (\d+)</span>', text))
