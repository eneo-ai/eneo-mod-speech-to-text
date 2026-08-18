#!/usr/bin/env bash
set -euo pipefail

cd /workspaces/eneo-mod-speech-to-text

python -m venv backend/.venv
backend/.venv/bin/python -m pip install --upgrade pip
backend/.venv/bin/pip install -r backend/requirements.txt

cd frontend
npm ci
