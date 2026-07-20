import packageMetadata from '../package.json';

const packageVersion = packageMetadata.version;

if (typeof packageVersion !== 'string' || packageVersion.trim().length === 0) {
  throw new Error('package.json must define a non-empty version');
}

/** Canonical package/runtime version used in protocol and outbound client metadata. */
export const PACKAGE_VERSION = packageVersion;
