"""Configure converter-generated Safari identifiers and native account transport."""
import pathlib
import json
import re
import sys
import shutil

project, bundle_id = pathlib.Path(sys.argv[1]), sys.argv[2]
display_name = sys.argv[3] if len(sys.argv) > 3 else project.name
if not display_name.strip() or any(c in display_name for c in '"\\/<>&'):
    raise SystemExit("Invalid Safari display name")
if not re.fullmatch(r"[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+", bundle_id):
    raise SystemExit("Invalid Safari bundle identifier")
pbxproj = next(project.glob("*.xcodeproj/project.pbxproj"))
text = pbxproj.read_text(encoding="utf-8")

def replace_id(match):
    old = match.group(1).strip('"')
    suffix = ".Extension" if old.endswith(".Extension") else ""
    return f'PRODUCT_BUNDLE_IDENTIFIER = "{bundle_id}{suffix}";'

text, count = re.subn(r"PRODUCT_BUNDLE_IDENTIFIER = ([^;]+);", replace_id, text)
if count != 4:
    raise SystemExit(f"Unexpected converter target layout: {count} bundle identifiers")
manifest = next(project.glob("* Extension/Resources/manifest.json"))
version = json.loads(manifest.read_text())["version"]
if not re.fullmatch(r"\d+\.\d+\.\d+", version):
    raise SystemExit(f"Unsupported Safari version: {version}")
text = re.sub(r"MARKETING_VERSION = [^;]+;", f"MARKETING_VERSION = {version};", text)
text = re.sub(r"\s*ENABLE_OUTGOING_NETWORK_CONNECTIONS = YES;", "", text)
text = text.replace("ENABLE_APP_SANDBOX = YES;", "ENABLE_APP_SANDBOX = YES;\n\t\t\t\tENABLE_OUTGOING_NETWORK_CONNECTIONS = YES;")
# Show the containing app under its display name in Finder, the menu bar and
# Safari's extension list ("<display name> 的 …"); target names stay ASCII.
text, count = re.subn(
    rf'INFOPLIST_KEY_CFBundleDisplayName = "{re.escape(project.name)}";',
    f'INFOPLIST_KEY_CFBundleDisplayName = "{display_name}";',
    text,
)
if count != 2:
    raise SystemExit(f"Unexpected converter app layout: {count} display names")
pbxproj.write_text(text, encoding="utf-8")
app_dir = project / project.name
for pattern in ("Resources/Base.lproj/Main.html", "Resources/Script.js", "Base.lproj/Main.storyboard"):
    for path in app_dir.glob(pattern):
        path.write_text(path.read_text(encoding="utf-8").replace(project.name, display_name), encoding="utf-8")

# Localize the converter's status page when the display name is Chinese.
if re.search(r"[一-鿿]", display_name):
    n = display_name
    status_text = {
        f"You can turn on {n}’s extension in Safari Extensions preferences.": f"你可以在 Safari 扩展设置中启用{n}。",
        f"{n}’s extension is currently on. You can turn it off in Safari Extensions preferences.": f"{n}已启用。你可以在 Safari 扩展设置中关闭它。",
        f"{n}’s extension is currently off. You can turn it on in Safari Extensions preferences.": f"{n}当前未启用。你可以在 Safari 扩展设置中启用它。",
        "Quit and Open Safari Extensions Preferences…": "退出并打开 Safari 扩展设置…",
        f"{n}’s extension is currently on. You can turn it off in the Extensions section of Safari Settings.": f"{n}已启用。你可以在 Safari 设置的“扩展”中关闭它。",
        f"{n}’s extension is currently off. You can turn it on in the Extensions section of Safari Settings.": f"{n}当前未启用。你可以在 Safari 设置的“扩展”中启用它。",
        f"You can turn on {n}’s extension in the Extensions section of Safari Settings.": f"你可以在 Safari 设置的“扩展”中启用{n}。",
        "Quit and Open Safari Settings…": "退出并打开 Safari 设置…",
    }
    for pattern in ("Resources/Base.lproj/Main.html", "Resources/Script.js"):
        for path in app_dir.glob(pattern):
            content = path.read_text(encoding="utf-8")
            for english, chinese in status_text.items():
                content = content.replace(english, chinese)
            path.write_text(content, encoding="utf-8")

# Replace the converter echo handler (which logs payloads) with the narrowly
# scoped account transport. Credentials must never enter unified logging.
handler = next(project.glob("* Extension/SafariWebExtensionHandler.swift"))
shutil.copyfile(pathlib.Path(__file__).resolve().parent.parent / "native/safari/SafariWebExtensionHandler.swift", handler)
