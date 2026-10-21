#!/bin/sh
# מעתיק את הקוד המשותף של האפליקציה לפונקציות השרת (אותו חישוב בדיוק)
cd "$(dirname "$0")" || exit 1
for f in monthly-summary kesef-alert kesef-calendar kesef-remind; do
  mkdir -p $f/shared && cp ../../app/js/exporter.js ../../app/js/categories.js ../../app/js/parse.js ../../app/js/fixed.js ../../app/js/demo-data.js $f/shared/
done
