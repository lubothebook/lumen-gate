#!/usr/bin/env bash
set -euo pipefail
# Vercel's vercel.json buildCommand is limited to 256 characters (openapi.vercel.sh).
# This script keeps that field short ("bash tools/vercel-build.sh") while doing
# the real multi-app build in one place. Frozen 1.0 + Gate 2.0 build to their
# own dist, then both are assembled under frontend/dist for a single Vercel output.
cd frontend && npm run build
cd ../gate2/web && npm run build -- --base=/gate2/
mkdir -p ../../frontend/dist/gate2 && cp -r dist/. ../../frontend/dist/gate2/
