//'use strict';

require('dotenv').config();

const browserify = require('browserify-middleware');
const express = require('express');
const expressWinston = require('express-winston');
const { appendFile } = require('fs');
const { sync: mkdirp } = require('mkdirp');
const { join } = require('path');
const puppeteer = require('puppeteer');
const { AccessToken } = require('twilio').jwt;
const winston = require('winston');
const readline = require('readline'); // so we can securely receive the token and room name.

const app = express();

let browser = null;
let page = null;
let server = null;
let actualRoomSid = null;
let localParticipantSid = null;
let shouldClose = false;
let isClosing = false;

const logger = winston.createLogger({
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(info => `${info.timestamp} ${info.level}: ${info.message}`),
  ),
  transports: [
    new winston.transports.Console()
  ]
});

const loggerMiddleware = expressWinston.logger({ winstonInstance: logger });

app.get('/', (req, res) => res.sendFile(join(__dirname, 'index.html')));

app.get('/bundle.js', browserify([
  'twilio-video',
  { [join(__dirname, 'app.js')]: { run: true } }
]));

app.use(loggerMiddleware);

async function main({ port, token, roomSid }) {
  console.log(`PID=${process.pid}\n`);

  logger.debug('Starting HTTP server...');
  server = await listen(port);
  logger.info(`Started HTTP server. Listening on ${port}.`);
  if (shouldClose) {
    await close();
    return;
  }

  logger.debug('Launching browser...');
  browser = await puppeteer.launch({
    executablePath: '/usr/local/bin/chromium-browser',
    args: [
      '--disable-gesture-requirement-for-media-playback',
      '--disable-dev-shm-usage'
    ]
  });
  logger.info('Launched browser.');
  if (shouldClose) {
    await close();
    return;
  }

  logger.debug('Opening new page...');
  page = await browser.newPage();
  logger.info('Opened new page.');
  if (shouldClose) {
    await close();
    return;
  }

  logger.debug(`Navigating to http://localhost:${port}...`);
  await page.goto(`http://localhost:${port}`, { waitUntil: 'domcontentloaded' });
  logger.info(`Navigated to http://localhost:${port}.`);
  if (shouldClose) {
    await close();
    return;
  }

  logger.debug('Registering callback(s)...');
  await Promise.all([
    page.exposeFunction('debug', message => { logger.debug(message); }),
    page.exposeFunction('error', message => { logger.error(message); }),
    page.exposeFunction('info', message => { logger.info(message); }),
    page.exposeFunction('parentClose', close),
    page.exposeFunction('createRecording', (filepath, metapath, mimeType) => {
      mkdirp(join(...filepath.slice(0, filepath.length - 1)));

      metaData =  { createTime: Date.now(), contentType: mimeType };
      metaString = JSON.stringify(metaData);
      appendFile(join(...metapath), Buffer.from(stringToArrayBuffer(metaString)), error => {
        if (error) {
          logger.error(`\nError writing metadata\n${indent(error.stack)}\n`);
          return;
        }
      });
      logger.info(`Created ${join(...filepath)} and wrote metadata ${metaString}`);
    }),
    page.exposeFunction('appendRecording', (filepath, chunk, start) => {
      const filename = join(...filepath);
      // NOTE: If we use Buffer.from instead of new Uint8Array here, the video gets corrupted almost immediately.
      // Presumably something in the semantics of appendFile treats the buffer content differently if it's a Buffer vs
      // if it's a Uint8Array.
      // The original code did new Buffer(stringToArrayBuffer(chunk)) which got warnings about a deprecated constructor.
      const buffer = new Uint8Array(stringToArrayBuffer(chunk));
      appendFile(filename, buffer, 'binary', error => {
        if (error) {
          logger.error(`\n\n${indent(error.stack)}\n`);
          return;
        }
        let elapsed = Date.now() - start;
        logger.debug(`Wrote ${buffer.length} bytes to ${filename} in ${elapsed}ms`);
      });
    })
  ]);
  logger.info('Registered callback(s).');
  if (shouldClose) {
    await close();
    return;
  }

  const {
    roomSid: actualRoomSid,
    localParticipantSid
  } = await page.evaluate(`main("${token}", "${roomSid}")`);
  if (shouldClose) {
    await close();
    return;
  }
} // main

function listen(port) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, error => error
      ? reject(error)
      : resolve(server));
  });
}

async function close(error) {
  if (isClosing) {
    return;
  }
  isClosing = true;

  if (error) {
    logger.error(`\n\n${indent(error.stack)}\n`);
  }

  if (page) {
    logger.debug('Shutting down any remaining recorders and disconnecting room...');
    await page.evaluate(`shutdown()`);
    logger.info('All recorders shut down and room disconnected.');
  }

  logger.info('Waiting 10 seconds for everything to finish before exiting...')

  await new Promise(resolve => setTimeout(resolve, 10000));

  if (server) {
    logger.debug('Closing HTTP server...');
    server.close();
    logger.info('Closed HTTP server.');
  }

  if (page) {
    logger.debug('Closing page...')
    await page.evaluate('close()');
    logger.info('Closed page.')
  }

  if (browser) {
    logger.debug('Closing browser...');
    await browser.close();
    logger.info('Closed browser.');
  }

  if (error) {
    process.exit(1);
    return;
  }
  process.exit();
}

function indent(str, n) {
  return str.split('\n').map(line => `  ${line}`).join('\n');
}

function stringToArrayBuffer(string) {
  const length = string.length;
  const buf = new ArrayBuffer(string.length);
  const bufView = new Uint8Array(buf);

  for (let i=0; i < length; i++) {
    bufView[i] = string.charCodeAt(i);
  }

  return buf;
}

[
  'SIGUSR2',
  'SIGINT'
].forEach(signal => {
  process.on(signal, () => {
    logger.debug(`Received ${signal}.`);
    shouldClose = true;
    close();
  });
});

// Code execution actually begins here 

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

// get params from stdin, separated by spaces. readline blocks waiting for stdin if you use the 'question' interface.
rl.question('', (answer) => {
  rl.close();
  var port, token, roomSid;
  [port, token, roomSid] = answer.split(' ');

  port = parseInt(port)

  const configuration = {
    port,
    token,
    roomSid
  };

  main(configuration).catch(error => {
    shouldClose = true;
    close(error);
  });
});