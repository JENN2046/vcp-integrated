#!/usr/bin/env bash
# Build the isolated Android acceptance shell. Only the fixture's public CA is bundled.
set -euo pipefail

if [[ $# -ne 3 || ! $2 =~ ^[0-9]{4,5}$ || $2 -lt 1024 || $2 -gt 65535 ]]; then
  echo "Usage: $0 PUBLIC_CA_DER PORT NEW_OUTPUT_DIR" >&2
  exit 2
fi

source_dir=$(dirname "$(realpath "$0")")
sdk=${ANDROID_SDK_ROOT:-"$HOME/Android/Sdk"}
build_tools="$sdk/build-tools/35.0.0"
platform="$sdk/platforms/android-36/android.jar"
ca=$(realpath "$1")
port=$2
out=$3
umask 077
mkdir "$out"
out=$(realpath "$out")
cd "$out"
mkdir -p resources/raw resources/xml classes dex
cp "$ca" resources/raw/fixture.der
cp "$source_dir/test_network.xml" resources/xml/test_network.xml
sed "s/FIXTURE_PORT/$port/g" "$source_dir/TestWindow.java" > TestWindow.java

"$build_tools/aapt2" compile --dir resources -o resources.zip
"$build_tools/aapt2" link -I "$platform" --manifest "$source_dir/AndroidManifest.xml" -o unsigned.apk resources.zip
javac --release 8 -cp "$platform" -d classes TestWindow.java "$source_dir/FixtureDocuments.java"
"$build_tools/d8" --lib "$platform" --min-api 29 --output dex classes/dev/nativesync/qa/send/*.class
(cd dex && zip -q ../unsigned.apk classes.dex)
"$build_tools/zipalign" -f 4 unsigned.apk aligned.apk
keytool -genkeypair -keystore temporary.keystore -storepass android -keypass android \
  -alias acceptance -keyalg RSA -keysize 2048 -validity 2 -dname 'CN=Temporary NativeSync USB acceptance'
"$build_tools/apksigner" sign --ks temporary.keystore --ks-pass pass:android --out android-send.apk aligned.apk
"$build_tools/apksigner" verify android-send.apk
rm temporary.keystore
