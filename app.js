'use strict';

const { connect } = require('twilio-video');

const trackClassName = {
  audio: 'RemoteAudioTrack',
  video: 'RemoteVideoTrack'
};

let room = null;
let shouldClose = false;
let isClosing = false;
let emptyRoomTimeout = null;
const roomEndingTimeoutSeconds = 60;
const roomStartingTimeoutSeconds = 600;

function indent(str, n) {
  return str.split('\n').map(line => `  ${line}`).join('\n');
}

window.addEventListener('error', event => {
  error(`\n\n${indent(event.error.stack)}\n`);
});

window.onunhandledrejection = event => {
  error(`\n\n${indent(event.reason.stack)}\n`);
};

async function main(token, roomSid) {
  debug('Connecting to Room...');
  room = await connect(token, {
    name: roomSid,
    tracks: []
  });
  info(`Connected to Room ${room.sid} as LocalParticipant ${room.localParticipant.sid}.`);
  if (shouldClose) {
    close();
    return;
  }

  const participants = [...room.participants.values()];
  if (!participants.length) {
    info('There are no RemoteParticipants in the Room.');
    info(`I will wait for ${roomEndingTimeoutSeconds} seconds before I give up and leave.`);
    emptyRoomTimeout = setTimeout(parentClose, roomStartingTimeoutSeconds * 1000);
  } else {
    let message = `There ${participants.length > 1 ? 'are' : 'is'} \
${participants.length} RemoteParticipant${participants.length > 1 ? 's' : ''} \
in the Room:\n\n`;
    participants.forEach(participant => {
      message += `  - RemoteParticipant ${participant.sid}\n`;
      participant.tracks.forEach(track => {
        if (track.kind === 'data') {
          return;
        }
        message += `    - ${trackClassName[track.kind]} ${track.sid}\n`;
      });
    });
    info(message);
    participants.forEach(participant => {
      participant.tracks.forEach(track => trackSubscribed(track, participant));
    });
  }

  room.on('participantConnected', participant => {
    info(`RemoteParticipant ${participant.sid} connected.`);
    if (emptyRoomTimeout != null) {
      clearTimeout(emptyRoomTimeout);
      emptyRoomTimeout = null;
    }
  });

  room.on('participantDisconnected', participant => {
    info(`RemoteParticipant ${participant.sid} disconnected.`);
    const participants = [...room.participants.values()];
    if (!participants.length) {
      info(`The last participant left. Will disconnect in ${roomEndingTimeoutSeconds} seconds`)
      emptyRoomTimeout = setTimeout(parentClose, roomEndingTimeoutSeconds * 1000);
    }
  });

  room.on('trackSubscribed', (track, participant) => {
    if (track.kind === 'data') {
      return;
    }
    info(`Subscribed to ${trackClassName[track.kind]} ${track.sid} published \
by RemoteParticipant ${participant.sid}`);
    trackSubscribed(track, participant);
  });

  room.on('trackUnsubscribed', (track, participant) => {
    if (track.kind === 'data') {
      return;
    }
    info(`Unsubscribed from ${trackClassName[track.kind]} ${track.sid} \
published by RemoteParticipant ${participant.sid}`);
    trackUnsubscribed(track.id, function(closingCount){});
  });

  room.once('disconnected', (room, error) => {
    info(`Disconnected from Room.`);
    parentClose(error);
  });

  room.once('room-ended', (room) => {
    info(`Room ended. Closing everything down.`);
    parentClose(`Room ended`);
  })

  return {
    roomSid: room.sid,
    localParticipantSid: room.localParticipant.sid
  };
}

window.main = main;


const recorders = new Map();
const videos = new Map();
const subscriptionCounts = new Map();
var recorderCount = 0;

function shutdown() {
  return new Promise((resolve, reject) => {
    function callback(count) {
      if (count <= 0) {
        resolve();
      }
    }
    if (recorders.size > 0) {
      info('Shutting down any remaining recorders...')
      if (recorderCount != recorders.size) {
        error(`Active recorder count ${recorderCount} doesn't match recorder size ${recorders.size}.`);
        error('Will reset active recorder count to match.');
        recorderCount = recorders.size;
      }
      recorders.forEach((recorder, trackid) => {
        trackUnsubscribed(trackid, callback);
      });
    } else {
      info('No active recorders to shut down.');
      resolve();
    }
  }).then(function() {
    if (room && room.state !== 'disconnected') {
      info('Disconnecting from Room...');
      room.disconnect();
    }
  });
}
window.shutdown = shutdown

function close(error) {
  if (isClosing) {
    return;
  }
  isClosing = true;
}
window.close = close;

function trackSubscribed(track, participant) {
  if (track.kind === 'data') {
    return;
  }

  record(track, participant);
}

function trackUnsubscribed(trackid, stopped_callback) {
  info(`Unsubscribe from ${trackid}`)
  const recorder = recorders.get(trackid);
  recorders.delete(trackid);
  if (recorder && recorder.state === 'recording') {
    // hack to see if this helps get streams always flushed cleanly before stopping.
    recorder.onpause = event => {
      let orig_handler = recorder.ondataavailable
      recorder.ondataavailable = event => {
        if (!event.data.size) {
          return;
        }    
        info(`Writing last ${event.data.size} bytes to ${recorder.filename}`)
        orig_handler(event)
      }
      info(`Paused ${recorder.filename}, requesting final data.`)
      recorder.requestData();
      info(`Stopping ${recorder.filename} completely.`)
      recorder.stop();
    }
    recorder.onstop = event => {
      recorderCount--;
      info(`Stopped ${recorder.filename}. Active recorder count is now ${recorderCount}.`)
      stopped_callback(recorderCount)
    }

    info(`Pausing ${recorder.filename} before stopping it.`)
    recorder.pause();
  } else {
    error(`Recorder for track ${trackid} was not found or is not recording. Maybe already unsubscribed?`)
  }
}

function _addDummyAudioStream(stream) {
    // NOTE(mroberts): This is a hack to workaround the following bug:
    //
    //   https://bugs.chromium.org/p/chromium/issues/detail?id=760760
    //
    // Chrome won't record video without audio, so we attach an empty audio track.
    const audioContext = new AudioContext();
    const destinationNode = audioContext.createMediaStreamDestination();
    const oscillatorNode = audioContext.createOscillator();
    oscillatorNode.frequency.setValueAtTime(0, audioContext.currentTime);
    oscillatorNode.connect(destinationNode);
    const [audioTrack] = destinationNode.stream.getAudioTracks();
    stream.addTrack(audioTrack);
}

function record(track, participant) {
  const trackid = track.id;
  const mediaStreamTrack = track.mediaStreamTrack;
  const stream = new MediaStream([mediaStreamTrack]);

  if (track.kind === 'video') {
    _addDummyAudioStream(stream);

    // Try to work-around https://bugs.chromium.org/p/chromium/issues/detail?id=945180 and
    // https://bugs.chromium.org/p/chromium/issues/detail?id=952700 .  We create a video
    // element on the page and attach the stream to it, then listen for resize events.
    // We map participant identity to the <video> so we reuse the same element for the same 
    // participant forever rather than creating additional ones every time something changes.
    let videoElement = videos.get(participant.identity);
    if (videoElement == null) {
      // Add the <video> for the participant to the document.
      videoElement = document.createElement("video");
      info(`Created a new <video> element for ${participant.identity}`);
    } else {
      // Replace the <video> with a clone; this gets rid of the old event listener. This matters
      // because we'll keep the old <video> if the participant leaves and comes back with a new
      // track/trackid.
      let videoElementClone = videoElement.cloneNode(true);
      videoElement.replaceWith(videoElementClone);
      videoElement = videoElementClone;
      info(`Replaced <video> element for ${participant.identity}`);
    }
    videos.set(participant.identity, videoElement);
    videoElement.srcObject = stream;

    videoElement.addEventListener("resize", function() {
      info(`Video for participant ${participant.identity} has resized video element ${videoElement.id}. Restarting recording on the same track.`);
      trackUnsubscribed(trackid, () => {
        // Create a new stream and a new recorder
        const stream = new MediaStream([mediaStreamTrack]);
        _addDummyAudioStream(stream);
        startRecorder(stream, track, participant.identity);
      });
    });
    info(`Added onresize event handler for ${participant.identity} video.`);
  }

  startRecorder(stream, track, participant.identity);
}

function startRecorder(stream, track, identity) {
  const videoCodec = MediaRecorder.isTypeSupported("video/webm;codecs=h264") ? 'h264' : 'vp8';
  const codec = track.kind == 'video'? videoCodec : 'opus'; 
  const mimeType = `${track.kind}/webm;codecs=${codec}`;
  info(`Using MIME type ${mimeType} to record`);

  const trackIndex = `${identity}.${track.kind}`;
  let subscriptionCount = subscriptionCounts.get(trackIndex) || 0;
  subscriptionCount++;
  subscriptionCounts.set(trackIndex, subscriptionCount);

  const filepath = [
    'recordings',
    room.name,
    trackIndex,
    `${subscriptionCount}.webm`
  ];
  const metapath = filepath.slice(0, -1).concat([`${subscriptionCount}.json`])

  const filename = filepath.join('/');
  info(`Begin recording ${filename}.`);
  createRecording(filepath, metapath, mimeType);

  info(`Starting recorder for ${filename}.`);
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 1500000 });
  recorder.filename = filename;
  recorders.set(track.id, recorder);

  recorder.onerror = event => {
    error(`Recorder error ${event.error.name}`);
  }

  recorder.ondataavailable = event => {
    if (!event.data.size) {
      error('Received a data available event of size 0! Doing nothing!')
      return;
    }
    
    const fileReader = new FileReader();
    fileReader.onload = event => {
      const buffer = event.target.result;
      info(`Writing ${buffer.byteLength} bytes to ${filename}`)
      let start = Date.now();
      appendRecording(filepath, arrayBufferToString(buffer), start);
    };
    fileReader.readAsArrayBuffer(event.data);
  };
  recorder.onstart = event  => {
    recorderCount++;
    info(`Recorder ${recorder.filename} started. Active recorder count is now ${recorderCount}.`);
  }

  recorder.start(10000);
}

// This function is needed because Puppeteer doesn't intrinsically know how to send 
// an ArrayBuffer over the wire. So this converts the ArrayBuffer into a nonsensical
// String containing the data in the ArrayBuffer.
// It's as convoluted as it is because evidently Javascript will blow its stack if the 
// size of the ArrayBuffer is too big when converting to a String.  So the JS 
// world's answer to that problem is to break the ArrayBuffer into smaller chunks
// (the code here originally and inexplicably used 255 bytes, expressed as Math.pow(2,8)-1)
// appending as it goes, then appending the last piece.
// I've moved the "if" from inside the loop to the outside to improve performance.
function arrayBufferToString(buffer) {
  const bufView = new Uint8Array(buffer);
  const length = bufView.length;
  const blocksize = 8192;
  const blocklength = parseInt(length / blocksize) * blocksize;

  let result = '';
 
  for (let i = 0; i < blocklength; i += blocksize) {
    result += String.fromCharCode.apply(null, bufView.subarray(i, i + blocksize));
  }
  // Append the last part of the array if the array is bigger than an even multiple
  // of the block size.
  if (length > blocklength) {
    result += String.fromCharCode.apply(null, bufView.subarray(blocklength, length));
  }

  return result;
}
