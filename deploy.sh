#!/bin/sh
# מעלה את הגרסה העדכנית של האפליקציה לאתר (GitHub Pages מענף gh-pages)
cd "$(dirname "$0")" || exit 1
# גרסה חדשה של המטמון — כך כל הטלפונים יקבלו את העדכון
sed -i '' "s/^const CACHE = .*/const CACHE = 'kesef-$(date +%Y%m%d%H%M%S)';/" app/sw.js
git add -A && git commit -q -m "עדכון האפליקציה" 2>/dev/null
git push -q origin main
git subtree split --prefix app -b gh-pages-tmp >/dev/null
git push -q -f origin gh-pages-tmp:gh-pages
git branch -D gh-pages-tmp >/dev/null
echo "עלה! בעוד דקה-שתיים יופיע באתר."
