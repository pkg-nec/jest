# @pkg-nec/babel-preset-jest

> Babel preset for all Jest plugins. This preset is automatically included when using [@pkg-nec/babel-jest](https://github.com/pkg-nec/jest/tree/main/packages/babel-jest).

## Install

```sh
$ npm install --save-dev @pkg-nec/babel-preset-jest
```

## Usage

### Via `babel.config.js` (Recommended)

```js
module.exports = {
  presets: ['jest'],
};
```

### Via CLI

```sh
$ babel script.js --presets jest
```

### Via Node API

```javascript
require('@babel/core').transform('code', {
  presets: ['jest'],
});
```
