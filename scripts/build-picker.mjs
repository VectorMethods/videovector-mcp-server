import { build } from 'esbuild';
import { readFile, mkdir, writeFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const styles = await readFile(new URL('ui/widget-base.css', root), 'utf8');
for (const [name, marker] of [['attachment-picker', 'PICKER_SCRIPT'], ['results-card', 'RESULTS_SCRIPT']]) {
const bundle = await build({
  entryPoints: [new URL(`ui/${name}.js`, root).pathname],
  bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', minify: true,
  define: { 'process.env.NODE_ENV': '"production"' },
  outfile: new URL(`dist/ui/${name}.js`, root).pathname,
});
const template = await readFile(new URL(`ui/${name}.html`, root), 'utf8');
const script = bundle.outputFiles.find(file => file.path.endsWith('.js')).text.replace(/<\/script/gi, '<\\/script');
const componentStyles = bundle.outputFiles.find(file => file.path.endsWith('.css'))?.text ?? '';
await mkdir(new URL('dist/ui/', root), { recursive: true });
await writeFile(new URL(`dist/ui/${name}.html`, root), template
  .replace('/* WIDGET_STYLES */', () => `${styles}\n${componentStyles}`)
  .replace(`/* ${marker} */`, () => script));
}
