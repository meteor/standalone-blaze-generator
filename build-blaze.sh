#!/bin/bash
./export-packages.sh templating spacebars-compiler jquery
mv client.js blaze.js
cat blaze-init.js >> blaze.js

# devel unminified version
env METEOR_OPTIONS='--debug' ./export-packages.sh templating spacebars-compiler jquery
mv client.js blaze.devel.js
cat blaze-init.js >> blaze.devel.js

# remove trailing '// 123' comments indicating original line numbers
sed -Eie 's/[[:space:]]*\/\/ [0-9]+$//g' blaze.devel.js
# remove special comments looking like '// info here ... //'
sed -Eie '/^\/\/.+\/\/$/d' blaze.devel.js
# remove special comments for source-map urls
sed -Eie '/^\/\/# sourceMappingURL=.*/d' blaze.devel.js

