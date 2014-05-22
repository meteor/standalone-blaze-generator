#!/bin/bash
./export-packages.sh templating spacebars-compiler jquery
mv client.js blaze.js
cat blaze-init.js >> blaze.js

# devel unminified version
env METEOR_OPTIONS='--debug' ./export-packages.sh templating spacebars-compiler jquery
mv client.js blaze.devel.js
cat blaze-init.js >> blaze.devel.js

