#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const commander = require("commander");
const main = require("./index");
commander
    .version('0.1.0')
    .option('-s, --start [yyyy-mm-dd]', '起始日期')
    .option('-e, --end [yyyy-mm-dd]', '結束日期')
    .option('-d, --destination [folder_path]', '目的資料夾')
    .parse(process.argv);
const start = new Date(commander.start);
const end = new Date(commander.end);
let destination;
if (commander.destination === undefined || commander.destination === '') {
    destination = 'downloads';
}
else {
    destination = commander.destination;
}
if (start.toString() === 'Invalid Date' ||
    end.toString() === 'Invalid Date') {
    console.log('see --help');
}
else {
    main.cliFunc(start, end, destination).then(() => {
        return 0;
    });
}
//# sourceMappingURL=cli.js.map