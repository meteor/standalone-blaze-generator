#!/bin/sh

# exit on errors
set -e

METEOR=~/meteor/meteor

rm -rf app-for-export
$METEOR create app-for-export && cd app-for-export
rm app-for-export.*
$METEOR remove meteor-platform

for var in "$@"
do
  $METEOR add "$var"
done

echo "Bundling..."

$METEOR build ../ --directory $METEOR_OPTIONS && cd ../
rm -f client.js

pushd bundle/programs/web.browser
JS_FILES=$(cat program.json  | jq '.manifest[] | select(.type == "js") | .path' -r)
cat $JS_FILES > ../../../client.js
popd

rm -rf app-for-export
rm -rf bundle

echo "Meteor = {};"|cat - client.js > /tmp/out && rm -f client.js && mv /tmp/out client.js

exit
