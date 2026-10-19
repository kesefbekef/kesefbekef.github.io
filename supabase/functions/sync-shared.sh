#!/bin/sh
# מעתיק את קוד האקסל/הקטגוריות של האפליקציה לפונקציות השרת (אותו חישוב בדיוק)
cd "$(dirname "$0")" || exit 1
for f in monthly-summary kesef-alert; do
  mkdir -p $f/shared && cp ../../app/js/exporter.js ../../app/js/categories.js ../../app/js/parse.js $f/shared/
done
