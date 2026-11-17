// `@rerun/cloud-mobile/*` resolves in jest.resolver.js, module by module, like the `paths` of tsconfig.json.
// Every test runs as iOS and as Android: a control with a `.android.tsx` twin is tested on both sides.
const shared = {
    "resolver": "./jest.resolver.js",
    "setupFiles": [
        "react-native-gesture-handler/jestSetup.js",
        "./jest.setup.js"
    ],
    "transformIgnorePatterns": [
        "node_modules/(?!(.pnpm|(jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|native-base|react-native-svg|marked|remend|use-intl|intl-messageformat|@formatjs/.*|icu-minify|@schummar/.*))"
    ],
    "moduleNameMapper": {
        "^remend$": "<rootDir>/node_modules/remend/dist/index.js"
    }
}

// @rerun/mac-pairing-client ships as ES modules in .mjs files, which the preset leaves untransformed:
// they go through the same Babel transform as the app's own sources.
function withMjs(platform) {
    const preset = require(`jest-expo/${platform}/jest-preset`)
    return { ...shared, "displayName": platform, "preset": `jest-expo/${platform}`, "transform": { "\\.mjs$": preset.transform["\\.[jt]sx?$"] } }
}

module.exports = {
    "projects": [withMjs("ios"), withMjs("android")]
}
