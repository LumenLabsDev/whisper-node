/**
 * Development script for manual testing of the `whisper` API.
 * Pass the audio path as argv[2] or set WHISPER_TEST_AUDIO.
 */
import { whisper } from "../index";

(async function run() {
  try {
    const inputFromArg = process.argv[2];
    const envInput = process.env.WHISPER_TEST_AUDIO;
    const filePath = inputFromArg || envInput;

    if (!filePath) {
      console.log(
        "Usage: ts-node src/scripts/test.ts <path-to-audio.wav>\n  or set WHISPER_TEST_AUDIO environment variable.",
      );
      process.exit(0);
    }

    const transcript = await whisper(filePath, {
      modelName: "base",
      whisperOptions: {
        language: "auto",
        word_timestamps: false,
        timestamp_size: 1,
      },
    });

    console.log("transcript", transcript);
    console.log(transcript.length, "rows.");
  } catch (error) {
    console.log("ERROR", error);
    process.exit(1);
  }
})();


