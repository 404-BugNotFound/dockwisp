import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { translateText } = require("../dist/translation/providers.js");
const result = await translateText({
  text: "Dockwisp translation check",
  provider: "mymemory",
  endpoint: "https://api.mymemory.translated.net/get",
});
console.log(
  JSON.stringify({
    provider: result.provider,
    sourceLanguage: result.sourceLanguage,
    targetLanguage: result.targetLanguage,
    translated: Boolean(result.translatedText),
  }),
);
