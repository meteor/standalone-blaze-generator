# meteor export packages

A simple script to bundle together meteor packages into standalone JavaScript files which aren't dependent on anything else in meteor.

## Usage

`./export-packages.sh ejson minimongo`

## Features

* Currently, this only works for client packages

## Future steps

* Bake this into the `meteor` executable
* Export serverside modules into commonjs modules to use in any node project
