"""Prints the CSP hashes of Slate's inline <script>s, for script-src in
deploy/Caddyfile. Rerun after editing either script.

Line endings are normalized to LF first, as the browser's HTML parser does
before it hashes a script, so a CRLF checkout gives the same hashes.

Run from the project root:  python deploy/csp_hashes.py
"""
import base64
import hashlib
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

for page in ('index.html', os.path.join('retro', 'index.html')):
    with open(os.path.join(ROOT, page), 'rb') as f:
        html = f.read().replace(b'\r\n', b'\n').replace(b'\r', b'\n')
    for script in re.findall(rb'<script>(.*?)</script>', html, re.S):
        digest = base64.b64encode(hashlib.sha256(script).digest()).decode()
        print(f"'sha256-{digest}'  ({page})")
