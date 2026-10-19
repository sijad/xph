import { readFile, writeFile, chmod } from 'node:fs/promises';
import { resolve } from 'node:path';
import { zipSync, strToU8 } from 'fflate';

// Local VSIX packaging without fetching vsce. Marketplace publication still uses vsce.
const directory = resolve(import.meta.dirname, '../packages/vscode');
const pkg = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'));
const xml = (value) =>
	String(value).replace(
		/[<>&"']/g,
		(char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[char],
	);
const files = {};
for (const path of [
	'package.json',
	'dist/extension.js',
	'language-configuration.json',
	'syntaxes/xph.tmLanguage.json',
	'syntaxes/astro-LICENSE.txt',
	'README.md',
]) {
	files[`extension/${path}`] = new Uint8Array(await readFile(resolve(directory, path)));
}
files['extension/LICENSE.txt'] = new Uint8Array(await readFile(resolve(directory, 'LICENSE')));
files['extension.vsixmanifest'] = strToU8(`<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
 <Metadata>
  <Identity Language="en-US" Id="${xml(pkg.name)}" Version="${xml(pkg.version)}" Publisher="${xml(pkg.publisher)}"/>
  <DisplayName>${xml(pkg.displayName)}</DisplayName>
  <Description xml:space="preserve">${xml(pkg.description)}</Description>
  <Tags>xph,php</Tags><Categories>Programming Languages</Categories><GalleryFlags>Public</GalleryFlags>
  <Properties>
   <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${xml(pkg.engines.vscode)}"/>
   <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value=""/>
   <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value=""/>
   <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace"/>
  </Properties>
  <License>extension/LICENSE.txt</License>
 </Metadata>
 <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation>
 <Dependencies/>
 <Assets>
  <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/>
  <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true"/>
  <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE.txt" Addressable="true"/>
 </Assets>
</PackageManifest>`);
files['[Content_Types].xml'] = strToU8(`<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="json" ContentType="application/json"/>
 <Default Extension="js" ContentType="application/javascript"/>
 <Default Extension="md" ContentType="text/markdown"/>
 <Default Extension="txt" ContentType="text/plain"/>
 <Default Extension="vsixmanifest" ContentType="text/xml"/>
</Types>`);
const target = resolve(directory, `${pkg.name}-${pkg.version}.vsix`);
await writeFile(target, zipSync(files, { level: 6 }));
await chmod(resolve(import.meta.dirname, '../packages/xph/dist/cli.js'), 0o755);
console.log(`Created ${target}`);
