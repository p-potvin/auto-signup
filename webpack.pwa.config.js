/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * The mobile PWA, built separately from the extension.
 *
 * Separate rather than another entry in webpack.config.js because the two
 * outputs are different artefacts: the extension ships as `dist/` with a
 * manifest.json, this ships as `dist-pwa/` served by nginx on
 * warden.vaultwares.ca. Sharing a config would mean one `clean: true` wiping
 * the other's output every build.
 *
 * Exported as an array because the service worker needs `target: 'webworker'`
 * and the app needs `target: 'web'`, and a config has one target.
 */
const path = require('path');
const webpack = require('webpack');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const CopyWebpackPlugin = require('copy-webpack-plugin');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');
const { version } = require('./package.json');

const OUT = path.resolve(__dirname, 'dist-pwa');

// Stamped once per invocation, so both configs below agree. The service worker
// keys its cache on this: the package version alone never moved between builds,
// so `activate` never found a stale cache to delete and cache-first kept serving
// the previous bundle after a deploy.
const BUILD_ID = Date.now().toString(36);

const tsRule = (configFile) => ({
    test: /\.tsx?$/,
    exclude: /node_modules/,
    use: { loader: 'ts-loader', options: configFile ? { configFile } : {} },
});

const app = {
    name: 'pwa',
    // `--mode development` on the CLI overrides this; see the dev:pwa script.
    mode: 'production',
    target: 'web',
    entry: { mobile: './src/mobile/index.tsx' },
    output: {
        path: OUT,
        filename: '[name].js',
        // Neither config may clean: webpack runs an array of configs in
        // parallel, and both emit into dist-pwa. The service worker compiles in
        // a fraction of the app's time, so `clean: true` here deleted a
        // service-worker.js that had already been written — a silent 404 that
        // only showed up as "offline shell unavailable" in the console. The
        // build script wipes the directory once, up front, instead.
        clean: false,
    },
    resolve: { extensions: ['.tsx', '.ts', '.js', '.jsx'] },
    module: {
        rules: [
            tsRule(),
            { test: /\.css$/, use: [MiniCssExtractPlugin.loader, 'css-loader', 'postcss-loader'] },
        ],
    },
    plugins: [
        new webpack.DefinePlugin({
            __VW_VERSION__: JSON.stringify(version),
            __VW_BUILD__: JSON.stringify(BUILD_ID),
        }),
        new MiniCssExtractPlugin({ filename: '[name].css' }),
        new HtmlWebpackPlugin({
            template: './src/mobile/index.html',
            filename: 'index.html',
            chunks: ['mobile'],
        }),
        new CopyWebpackPlugin({
            patterns: [
                { from: 'public/pwa/manifest.webmanifest', to: 'manifest.webmanifest' },
                { from: 'public/icons/icon-180.png', to: 'icons/icon-180.png' },
                { from: 'public/icons/icon-192.png', to: 'icons/icon-192.png' },
                { from: 'public/icons/icon-512.png', to: 'icons/icon-512.png' },
            ],
        }),
    ],
    // One bundle: the app is a single screen deep and code-splitting would only
    // add round trips over a tailnet link that is already the slow part.
    optimization: { splitChunks: false },
    performance: {
        // ML-KEM-768 and Argon2id are the bulk of it and both are load-bearing.
        // A warning that can never be acted on is noise.
        hints: false,
    },
};

const serviceWorker = {
    name: 'pwa-sw',
    mode: 'production',
    target: 'webworker',
    entry: { 'service-worker': './src/mobile/service-worker.ts' },
    output: {
        path: OUT,
        filename: '[name].js',
        clean: false,
    },
    resolve: { extensions: ['.ts', '.js'] },
    // Its own tsconfig: lib.webworker and lib.dom both declare `self`, so a
    // service worker cannot be typechecked under the app's DOM config.
    module: { rules: [tsRule('tsconfig.sw.json')] },
    plugins: [new webpack.DefinePlugin({
        __VW_VERSION__: JSON.stringify(version),
        __VW_BUILD__: JSON.stringify(BUILD_ID),
    })],
};

module.exports = [app, serviceWorker];
