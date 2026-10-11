#!/bin/sh
# Builds the .vsix without npm.
#
# A .vsix is a zip holding three things:
#
#   [Content_Types].xml
#   extension.vsixmanifest
#   extension/**            <- the files VS Code actually loads
#
# So neither a build step nor @vscode/vsce is required; `zip` is enough. The manifest
# schema was written against a real .vsix downloaded from the Marketplace.
#
# The icon path is read from the `icon` field of package.json, so moving the file only
# means editing that one field. The Marketplace rejects SVG and wants a PNG of at least
# 128x128.
#
# Usage: tools/pack.sh [output directory]      (default: dist/)

set -eu

here=$(cd "$(dirname "$0")" && pwd)
src=$(dirname "$here")
out=${1:-"$src/dist"}
json="$src/package.json"

read_top() {
  sed -n "s/^  \"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$json" | head -1
}

read_array() {
  awk -v key="\"$1\"" '
    index($0, "  " key) == 1 { inside = 1; next }
    inside && /\]/ { exit }
    inside { gsub(/[",]/, ""); gsub(/^[ \t]+|[ \t]+$/, ""); if (length($0) > 0) printf "%s,", $0 }
  ' "$json" | sed 's/,$//'
}

name=$(read_top name)
version=$(read_top version)
publisher=$(read_top publisher)
display=$(read_top displayName)
description=$(read_top description)
icon=$(read_top icon)
tagline=$(read_array keywords)
categories=$(read_array categories)
engine=$(sed -n 's/.*"vscode"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$json" | head -1)

if [ -z "$name" ] || [ -z "$version" ] || [ -z "$publisher" ]; then
  echo "pack.sh: could not read name, version or publisher from package.json" >&2
  exit 1
fi

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT INT TERM

# Only what the extension needs at runtime. Sources, tests and tools stay out.
mkdir -p "$stage/extension/lib" "$stage/extension/assets/fonts"
cp "$src/package.json" "$src/extension.js" "$src/README.md" "$src/CHANGELOG.md" "$stage/extension/"
cp "$src/LICENSE" "$stage/extension/LICENSE.txt"
cp "$src"/lib/*.js "$stage/extension/lib/"
cp "$src"/assets/fonts/*.woff "$stage/extension/assets/fonts/"

icon_element=''
icon_asset=''
if [ -n "$icon" ] && [ -f "$src/$icon" ]; then
  icon_name=$(basename "$icon")
  case "$(file -b "$src/$icon")" in
    *PNG*) ;;
    *) echo "pack.sh: warning - $icon is not a PNG, the Marketplace will reject it" >&2 ;;
  esac
  mkdir -p "$stage/extension/images"
  cp "$src/$icon" "$stage/extension/images/$icon_name"
  icon_element=$(printf '\t\t<Icon>extension/images/%s</Icon>' "$icon_name")
  icon_asset=$(printf '\t\t<Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="extension/images/%s" Addressable="true" />' "$icon_name")
fi

cat > "$stage/[Content_Types].xml" <<'XML'
<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension=".js" ContentType="application/javascript"/><Default Extension=".json" ContentType="application/json"/><Default Extension=".md" ContentType="text/markdown"/><Default Extension=".png" ContentType="image/png"/><Default Extension=".txt" ContentType="text/plain"/><Default Extension=".woff" ContentType="application/font-woff"/><Default Extension=".vsixmanifest" ContentType="text/xml"/></Types>
XML

cat > "$stage/extension.vsixmanifest" <<XML
<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
	<Metadata>
		<Identity Language="en-US" Id="$name" Version="$version" Publisher="$publisher" />
		<DisplayName>$display</DisplayName>
		<Description xml:space="preserve">$description</Description>
		<Tags>$tagline</Tags>
		<Categories>$categories</Categories>
		<GalleryFlags>Public</GalleryFlags>
		<Properties>
			<Property Id="Microsoft.VisualStudio.Code.Engine" Value="$engine" />
			<Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
			<Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
			<Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace" />
			<Property Id="Microsoft.VisualStudio.Code.LocalizedLanguages" Value="" />
			<Property Id="Microsoft.VisualStudio.Code.EnabledApiProposals" Value="" />
			<Property Id="Microsoft.VisualStudio.Code.ExecutesCode" Value="true" />
			<Property Id="Microsoft.VisualStudio.Services.GitHubFlavoredMarkdown" Value="true" />
			<Property Id="Microsoft.VisualStudio.Services.Content.Pricing" Value="Free" />
		</Properties>
		<License>extension/LICENSE.txt</License>
$icon_element
	</Metadata>
	<Installation>
		<InstallationTarget Id="Microsoft.VisualStudio.Code" />
	</Installation>
	<Dependencies />
	<Assets>
		<Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
		<Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
		<Asset Type="Microsoft.VisualStudio.Services.Content.Changelog" Path="extension/CHANGELOG.md" Addressable="true" />
		<Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE.txt" Addressable="true" />
$icon_asset
	</Assets>
</PackageManifest>
XML

mkdir -p "$out"
vsix="$out/$name-$version.vsix"
rm -f "$vsix"

# The zip glob would collide with the literal name [Content_Types].xml, so no file name is
# passed: the whole staging directory is packed instead (-D: no directory entries,
# -X: no extra file attributes).
(cd "$stage" && zip -q -X -D -r "$vsix" .)

fail() {
  echo "pack.sh: $1" >&2
  exit 1
}

# The manifest identity and the packaged package.json must agree on the version.
unzip -p "$vsix" extension/package.json | grep -q "\"version\": \"$version\"" \
  || fail "packaged package.json does not carry version $version"

# The carrot font is what the status bar icon resolves to, so it has to be inside.
for entry in extension/extension.js extension/lib/tasksJson.js extension/assets/fonts/task-runner.woff; do
  unzip -Z1 "$vsix" | grep -qx "$entry" || fail "$entry is missing from the package"
done

# A declared icon must be both inside the package and registered in the manifest.
if [ -n "$icon_element" ]; then
  unzip -Z1 "$vsix" | grep -q '^extension/images/' || fail "the icon file was not packaged"
  unzip -p "$vsix" extension.vsixmanifest | grep -q 'Icons.Default' \
    || fail "the manifest has no Icons.Default entry"
fi

echo "wrote $vsix"
unzip -Z1 "$vsix" | sed 's/^/  /'
