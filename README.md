# Test it

```
npm run build && sam local start-api
```

# Deploy

```
npm run build && npm run package && npm run deploy

rm -rf dist && tsc && rm -rf dist/node_modules && npm publish --access public
```

# Reference

Used this project as template: https://github.com/alukach/aws-sam-typescript-boilerplate
