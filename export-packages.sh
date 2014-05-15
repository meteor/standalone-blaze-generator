#!/bin/sh

METEOR=meteor

$METEOR create app-for-export && cd app-for-export
rm app-for-export.*
$METEOR remove standard-app-packages

for var in "$@"
do
  $METEOR add "$var"
done

echo "Bundling..."
$METEOR bundle ../bundle.tgz && cd ../ && tar -zxvf bundle.tgz
pushd bundle && mv programs/client/*.js ../client.js && popd

rm -rf bundle.tgz
rm -rf app-for-export
rm -rf bundle

echo "Meteor = {};"|cat - client.js > /tmp/out && mv /tmp/out client.js

echo "Client bundle available in client.js"
exit
