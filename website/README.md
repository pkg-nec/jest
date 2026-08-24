# Jest website

> **Upstream infrastructure notice:** These retained website sources describe upstream Jest infrastructure. This independently maintained `@pkg-nec/jest` fork does not control the upstream Netlify sites or `jestjs.io` deployments.

The Jest website is based on [Docusaurus 3](https://docusaurus.io/).

## Run the dev server

You will need Node >=20.

The first time, install the website dependencies from this directory:

```bash
corepack enable
yarn install
```

Fetch `backers.json` file by running

```bash
node fetchSupporters.js
```

Then, run the server via

```bash
yarn start
```

## Upstream website publishing

The following describes the upstream Jest website deployment; it is not operated by this fork:

- Netlify site: https://app.netlify.com/sites/jestjs
- Netlify url: https://jestjs.netlify.app
- Production url: https://jestjs.io

[![Netlify Status](https://api.netlify.com/api/v1/badges/4570042d-b147-40fd-84fc-3bfd63639af7/deploy-status)](https://app.netlify.com/sites/jestjs/deploys)

## Upstream archive

An older upstream Docusaurus v1 site exists for versions <= 25.x:

- Netlify site: https://app.netlify.com/sites/jest-archive
- Url: https://archive.jestjs.io
- GitHub branch: https://github.com/jestjs/jest/tree/jest-website-v1
