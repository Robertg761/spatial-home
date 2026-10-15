// Hands a scan's JSON to another app as a file, so the web editor's Open can read it.

import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

/** Writes `text` to a file called `name` in the app's cache and opens the share sheet for it. */
export async function shareJsonFile(name: string, text: string): Promise<void> {
  if (!(await Sharing.isAvailableAsync()))
    throw new Error('Sharing isn’t available on this device.');
  const file = new File(Paths.cache, name);
  file.write(text);
  await Sharing.shareAsync(file.uri, {
    mimeType: 'application/json',
    UTI: 'public.json',
    dialogTitle: name,
  });
}
