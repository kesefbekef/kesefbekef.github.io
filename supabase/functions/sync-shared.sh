#!/bin/sh
# מעתיק את קוד האקסל של האפליקציה לפונקציית השרת (אותו עיצוב בדיוק)
cd "$(dirname "$0")" && mkdir -p monthly-summary/shared && cp ../../app/js/exporter.js ../../app/js/categories.js ../../app/js/parse.js monthly-summary/shared/
