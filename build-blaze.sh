#!/bin/bash
PACKAGES="templating spacebars-compiler jquery blaze spacebars reactive-var"

./export-packages.sh $PACKAGES
mv client.js blaze.js
cat blaze-init.js >> blaze.js

# devel unminified version
env METEOR_OPTIONS='--debug' ./export-packages.sh $PACKAGES
mv client.js blaze.devel.js
cat blaze-init.js >> blaze.devel.js

# remove trailing '// 123' comments indicating original line numbers
sed -E -i '' 's/[[:space:]]*\/\/ [0-9]+$//g' blaze.devel.js
# remove special comments looking like '// info here ... //'
sed -E -i '' '/^\/\/.+\/\/$/d' blaze.devel.js
# remove special comments for source-map urls
sed -E -i ''  '/^\/\/# sourceMappingURL=.*/d' blaze.devel.js

