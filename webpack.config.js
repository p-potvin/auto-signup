/* eslint-disable @typescript-eslint/no-require-imports */
const path = require('path');
const webpack = require('webpack');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const CopyWebpackPlugin = require('copy-webpack-plugin');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');
const { version } = require('./package.json');

module.exports = {
    entry: {
        background: './src/background/index.ts',
        content: './src/content/index.ts',
        // Runs in the page's world to replace navigator.credentials; must stay
        // a separate bundle from `content` because the two live in different
        // JavaScript worlds.
        'webauthn-inject': './src/webauthn/inject.ts',
        'webauthn-bridge': './src/webauthn/bridge.ts',
        popup: './src/popup/index.tsx',
        vault: './src/vault/index.tsx',
        onboarding: './src/onboarding/index.tsx',
    },
    output: {
        path: path.resolve(__dirname, 'dist'),
        filename: '[name].js',
        clean: true,
    },
    resolve: {
        extensions: ['.tsx', '.ts', '.js', '.jsx'],
    },
    module: {
        rules: [
            {
                test: /\.tsx?$/,
                use: 'ts-loader',
                exclude: /node_modules/,
            },
            {
                test: /\.css$/,
                use: [MiniCssExtractPlugin.loader, 'css-loader', 'postcss-loader'],
            },
        ],
    },
    plugins: [
        new webpack.DefinePlugin({
            __VW_VERSION__: JSON.stringify(version),
        }),
        new MiniCssExtractPlugin({ filename: '[name].css' }),
        new HtmlWebpackPlugin({
            template: './src/popup/index.html',
            filename: 'popup.html',
            chunks: ['popup'],
        }),
        new HtmlWebpackPlugin({
            template: './src/vault/index.html',
            filename: 'vault.html',
            chunks: ['vault'],
        }),
        new HtmlWebpackPlugin({
            template: './src/onboarding/index.html',
            filename: 'onboarding.html',
            chunks: ['onboarding'],
        }),
        new CopyWebpackPlugin({
            patterns: [
                { from: 'manifest.json', to: 'manifest.json' },
                { from: 'public/icons', to: 'icons' },
            ],
        }),
    ],
    optimization: {
        splitChunks: false,
    },
};
