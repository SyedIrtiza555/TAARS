from __future__ import annotations

import argparse
import re
import sys
import shutil
from pathlib import Path

from pypdf import PdfReader, PdfWriter
from playwright.sync_api import sync_playwright
import pypdfium2 as pdfium
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
GUIDE_DIR = ROOT / "docs" / "guide"
GUIDE_HTML = GUIDE_DIR / "guide.html"
COVER_HTML = GUIDE_DIR / "cover.html"
CSS = GUIDE_DIR / "guide.css"
OUT_DIR = GUIDE_DIR / "_build"
FINAL_PDF = ROOT / "docs" / "WhatsApp-Agent-Guide.pdf"

SECTIONS = [
    "about",
    "contents",
    "part-1",
    "meet",
    "start",
    "use",
    "privacy",
    "user-help",
    "part-2",
    "architecture",
    "install",
    "dashboard",
    "classic",
    "hub",
    "tui",
    "operations",
    "security",
    "admin-help",
    "appendix",
    "appendix-b",
    "appendix-c",
    "glossary",
]

CHAPTERS_PART_1 = ["meet", "start", "use", "privacy", "user-help"]
CHAPTERS_PART_2 = [
    "architecture",
    "install",
    "dashboard",
    "classic",
    "hub",
    "tui",
    "operations",
    "security",
    "admin-help",
]
REFERENCE = ["appendix", "appendix-b", "appendix-c", "glossary"]

TITLES = {
    "about": "About this guide",
    "contents": "Contents",
    "part-1": "Part I — Using the agent",
    "meet": "1. Meet your WhatsApp agent",
    "start": "2. Getting started",
    "use": "3. Everyday use",
    "privacy": "4. Privacy, data, and safety",
    "user-help": "5. End-user troubleshooting & FAQ",
    "part-2": "Part II — Running the system",
    "architecture": "6. System at a glance",
    "install": "7. Install and first run",
    "dashboard": "8. Dashboard tour",
    "classic": "9. Classic bot administration",
    "hub": "10. Multi-agent hub",
    "tui": "11. Terminal monitor",
    "operations": "12. Operations, limits, and backups",
    "security": "13. Security checklist",
    "admin-help": "14. Admin troubleshooting & FAQ",
    "appendix": "A. Environment variables",
    "appendix-b": "B. Scripts, ports, and data map",
    "appendix-c": "C. Cron, models, and API limits",
    "glossary": "Glossary",
}

FOOTER = """
<div style="width:100%; box-sizing:border-box; padding:0 19mm; font-family:'Segoe UI', Arial, sans-serif; font-size:7pt; color:#75877b;">
  <div style="border-top:0.3mm solid #dce6df; padding-top:2.2mm; display:flex; justify-content:space-between; align-items:baseline;">
    <span>WhatsApp Agent &nbsp;·&nbsp; User &amp; Administrator Guide</span>
    <span>Edition 1.0 &nbsp;·&nbsp; Page <span class="pageNumber"></span></span>
  </div>
</div>
"""

MARKER_CSS = """
.page-marker {
  display: block;
  height: 1px;
  overflow: visible;
  font-size: 1px;
  line-height: 1px;
  color: #ffffff;
  white-space: nowrap;
}
"""


def fail(message: str) -> None:
    print(f"ERROR: {message}", file=sys.stderr)
    raise SystemExit(1)


def check_sources() -> None:
    for path in (GUIDE_HTML, COVER_HTML, CSS):
        if not path.exists():
            fail(f"missing {path}")
    html = GUIDE_HTML.read_text(encoding="utf-8")
    missing = [section for section in SECTIONS if f'id="{section}"' not in html]
    if missing:
        fail(f"missing sections: {missing}")
    if html.count("<section") != html.count("</section>"):
        fail("unbalanced <section> tags")
    assets = sorted((GUIDE_DIR / "assets").glob("*.png"))
    if len(assets) != 11:
        fail(f"expected 11 screenshots, found {len(assets)}")


def wait_for_page(page) -> None:
    page.wait_for_load_state("networkidle")
    page.evaluate("document.fonts.ready")
    page.wait_for_function(
        "Array.from(document.images).every((img) => img.complete && img.naturalWidth > 0)"
    )
    page.wait_for_timeout(250)


def apply_markers(page) -> None:
    css = page.locator("style#build-markers")
    if css.count() == 0:
        page.add_style_tag(content=MARKER_CSS)
    page.evaluate(
        """(sections) => {
            for (const id of sections) {
                const section = document.getElementById(id);
                if (!section) continue;
                const marker = document.createElement('span');
                marker.className = 'page-marker';
                marker.textContent = `ZZPAGE${id.toUpperCase()}ZZ`;
                section.prepend(marker);
            }
            document.querySelectorAll('a.toc-row .page').forEach((el) => {
                el.textContent = '00';
            });
        }""",
        SECTIONS,
    )


def render_body(browser, out_path: Path, final_pages: dict[str, int] | None = None) -> None:
    page = browser.new_page(viewport={"width": 1240, "height": 1754})
    page.goto(GUIDE_HTML.as_uri(), wait_until="networkidle")
    wait_for_page(page)
    page.emulate_media(media="print")
    if final_pages is None:
        apply_markers(page)
    else:
        page.evaluate(
            """(pages) => {
                document.querySelectorAll('a.toc-row').forEach((row) => {
                    const id = row.getAttribute('href').slice(1);
                    const value = pages[id];
                    if (value) row.querySelector('.page').textContent = String(value);
                });
            }""",
            final_pages,
        )
    page.pdf(
        path=str(out_path),
        width="210mm",
        height="297mm",
        margin={"top": "18mm", "bottom": "19mm", "left": "19mm", "right": "19mm"},
        print_background=True,
        display_header_footer=True,
        header_template="<span></span>",
        footer_template=FOOTER,
        prefer_css_page_size=False,
        scale=1,
    )
    page.close()


def render_cover(browser, out_path: Path) -> None:
    page = browser.new_page(viewport={"width": 1240, "height": 1754})
    page.goto(COVER_HTML.as_uri(), wait_until="networkidle")
    wait_for_page(page)
    page.emulate_media(media="print")
    page.pdf(
        path=str(out_path),
        width="210mm",
        height="297mm",
        margin={"top": "0", "bottom": "0", "left": "0", "right": "0"},
        print_background=True,
        display_header_footer=False,
        prefer_css_page_size=False,
        scale=1,
    )
    page.close()


def extract_pages(pdf_path: Path) -> list[str]:
    reader = PdfReader(str(pdf_path))
    texts: list[str] = []
    for page in reader.pages:
        try:
            texts.append(page.extract_text() or "")
        except Exception as exc:  # noqa: BLE001 - keep the build diagnosable
            print(f"warning: text extraction failed on a page: {exc}", file=sys.stderr)
            texts.append("")
    return texts


def find_page_map(texts: list[str]) -> dict[str, int]:
    pages: dict[str, int] = {}
    pattern = re.compile(r"ZZPAGE([A-Z0-9-]+)ZZ")
    for page_number, text in enumerate(texts, start=1):
        # Chromium keeps widely tracked 1px glyphs as separate text runs. Remove
        # whitespace so the marker survives extraction regardless of kerning.
        compact = re.sub(r"\s+", "", text)
        for raw in pattern.findall(compact):
            section = raw.lower()
            if section in SECTIONS and section not in pages:
                pages[section] = page_number
    missing = [section for section in SECTIONS if section not in pages]
    if missing:
        fail(f"could not locate section markers: {missing}")
    return pages


def update_toc_source(pages: dict[str, int]) -> None:
    html = GUIDE_HTML.read_text(encoding="utf-8")
    for section, page_number in pages.items():
        html = html.replace("{{PAGE_" + section + "}}", str(page_number))
    for section, page_number in pages.items():
        pattern = re.compile(
            r'(<a class="toc-row" href="#'
            + re.escape(section)
            + r'">.*?<span class="page">)([^<]*)(</span>)',
            re.DOTALL,
        )
        html, count = pattern.subn(
            lambda match: match.group(1) + str(page_number) + match.group(3),
            html,
            count=1,
        )
        if count == 0:
            # About, Contents, and the two part dividers are intentionally not
            # listed as TOC rows; every actual row must be found exactly once.
            if f'href="#{section}"' in html:
                fail(f"could not update TOC row for {section}")
        elif count != 1:
            fail(f"updated too many TOC rows for {section}")
    remaining = re.findall(r"\{\{PAGE_[^}]+\}\}", html)
    if remaining:
        fail(f"unreplaced TOC placeholders: {sorted(set(remaining))}")
    GUIDE_HTML.write_text(html, encoding="utf-8")


def merge_pdfs(cover_pdf: Path, body_pdf: Path, out_pdf: Path, pages: dict[str, int]) -> None:
    cover_reader = PdfReader(str(cover_pdf))
    body_reader = PdfReader(str(body_pdf))
    if len(cover_reader.pages) != 1:
        fail(f"cover rendered on {len(cover_reader.pages)} pages")
    if not body_reader.pages:
        fail("body rendered with no pages")

    writer = PdfWriter()
    for page in cover_reader.pages:
        writer.add_page(page)
    for page in body_reader.pages:
        writer.add_page(page)

    offset = 1
    writer.add_outline_item("Cover", 0)
    writer.add_outline_item("About this guide", offset + pages["about"] - 1)
    writer.add_outline_item("Contents", offset + pages["contents"] - 1)

    part_one = writer.add_outline_item(
        TITLES["part-1"], offset + pages["part-1"] - 1
    )
    for section in CHAPTERS_PART_1:
        writer.add_outline_item(
            TITLES[section], offset + pages[section] - 1, parent=part_one
        )

    part_two = writer.add_outline_item(
        TITLES["part-2"], offset + pages["part-2"] - 1
    )
    for section in CHAPTERS_PART_2:
        writer.add_outline_item(
            TITLES[section], offset + pages[section] - 1, parent=part_two
        )

    reference = writer.add_outline_item(
        "Reference", offset + pages["appendix"] - 1
    )
    for section in REFERENCE:
        writer.add_outline_item(
            TITLES[section], offset + pages[section] - 1, parent=reference
        )

    writer.add_metadata(
        {
            "/Title": "WhatsApp Agent — User & Administrator Guide",
            "/Author": "WhatsApp Agent",
            "/Subject": "Self-hosted classic WhatsApp bot and local multi-agent hub",
            "/Keywords": "WhatsApp, agent, OpenCode, MCP, RAG, multi-agent, self-hosted",
            "/Creator": "WhatsApp Agent documentation",
            "/Producer": "WhatsApp Agent build pipeline",
        }
    )
    try:
        writer.set_page_label(0, 0, style="/D", prefix="Cover ")
        writer.set_page_label(1, len(writer.pages) - 1, style="/D", start=1)
    except Exception as exc:  # noqa: BLE001 - labels are cosmetic
        print(f"warning: could not set page labels: {exc}", file=sys.stderr)

    out_pdf.parent.mkdir(parents=True, exist_ok=True)
    with out_pdf.open("wb") as handle:
        writer.write(handle)


def render_previews(pdf_path: Path, preview_dir: Path) -> list[Path]:
    if preview_dir.exists():
        shutil.rmtree(preview_dir)
    preview_dir.mkdir(parents=True)
    document = pdfium.PdfDocument(str(pdf_path))
    images: list[Path] = []
    for index in range(len(document)):
        page = document[index]
        bitmap = page.render(scale=110 / 72)
        image = bitmap.to_pil().convert("RGB")
        out = preview_dir / f"page-{index + 1:02d}.png"
        image.save(out)
        images.append(out)
    document.close()

    sheet_paths: list[Path] = []
    thumb_w = 430
    thumb_h = int(thumb_w * 297 / 210)
    cols, rows = 2, 2
    for sheet_index in range(0, len(images), cols * rows):
        batch = images[sheet_index : sheet_index + cols * rows]
        sheet = Image.new("RGB", (cols * (thumb_w + 20) + 20, rows * (thumb_h + 40) + 20), "#d9e0db")
        draw = ImageDraw.Draw(sheet)
        for offset, image_path in enumerate(batch):
            img = Image.open(image_path).convert("RGB")
            img.thumbnail((thumb_w, thumb_h), Image.Resampling.LANCZOS)
            col = offset % cols
            row = offset // cols
            x = 20 + col * (thumb_w + 20) + (thumb_w - img.width) // 2
            y = 20 + row * (thumb_h + 40) + 18
            sheet.paste(img, (x, y))
            draw.text((x, y - 14), f"Page {sheet_index + offset + 1}", fill="#1d3528")
        sheet_path = preview_dir / f"contact-{sheet_index // (cols * rows) + 1:02d}.png"
        sheet.save(sheet_path)
        sheet_paths.append(sheet_path)
    return sheet_paths


def verify_pdf(pdf_path: Path, pages: dict[str, int]) -> None:
    reader = PdfReader(str(pdf_path))
    expected = len(reader.pages)
    print(f"PDF pages: {expected}")
    print(f"PDF size: {pdf_path.stat().st_size / 1024 / 1024:.2f} MB")
    first = reader.pages[0].mediabox
    print(f"Page size: {float(first.width):.2f} x {float(first.height):.2f} pt")
    if abs(float(first.width) - 595.28) > 1 or abs(float(first.height) - 841.89) > 1:
        print("warning: first page is not A4", file=sys.stderr)
    text = "\n".join((page.extract_text() or "") for page in reader.pages)
    if "ZZPAGE" in text:
        fail("page markers leaked into the final PDF")
    if "{{PAGE_" in text:
        fail("TOC placeholders leaked into the final PDF")
    if "Sorry, I could not handle that message" not in text:
        print("warning: expected fallback copy not found", file=sys.stderr)
    if reader.outline is None:
        fail("no PDF outline")
    if len(reader.outline) < 4:
        fail(f"outline too small: {len(reader.outline)}")
    print(f"Outline items: {len(reader.outline)}")
    print(f"TOC page map: {pages}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Build the combined WhatsApp Agent guide PDF")
    parser.add_argument("--no-previews", action="store_true", help="skip page previews")
    args = parser.parse_args()

    check_sources()
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    pass1 = OUT_DIR / "body-pass1.pdf"
    body_final = OUT_DIR / "body-final.pdf"
    cover_pdf = OUT_DIR / "cover.pdf"

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            print("Rendering cover...")
            render_cover(browser, cover_pdf)
            print("Rendering body (pass 1)...")
            render_body(browser, pass1)
        finally:
            browser.close()

    print("Locating sections...")
    pages = find_page_map(extract_pages(pass1))
    print(f"Located {len(pages)} sections")
    update_toc_source(pages)

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            print("Rendering body (final)...")
            render_body(browser, body_final, pages)
        finally:
            browser.close()

    print("Merging PDF...")
    merge_pdfs(cover_pdf, body_final, FINAL_PDF, pages)
    verify_pdf(FINAL_PDF, pages)

    if not args.no_previews:
        print("Rendering previews...")
        sheets = render_previews(FINAL_PDF, OUT_DIR / "pages")
        print(f"Preview sheets: {len(sheets)}")
        for sheet in sheets:
            print(f"  {sheet}")

    print(f"Wrote {FINAL_PDF}")


if __name__ == "__main__":
    main()
