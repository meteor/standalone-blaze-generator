#!/bin/bash
./export-packages.sh templating spacebars-compiler jquery
mv client.js blaze.js
cat blaze-init.js >> blaze.js
