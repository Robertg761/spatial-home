// What the scan screen shows once the rooms are imported: the plan's rooms, any notes, and ways
// to share it.

import { serializeLayout } from '@spatial-home/home-model';
import type { ImportResult } from '@spatial-home/scan-import';
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { buildScan, floorArea, type CapturedRoom } from './guided.ts';
import { shareJsonFile } from './share.ts';
import { Button, uiStyles } from './ui.tsx';

export function Review({
  rooms,
  result,
  onScanMore,
  onStartOver,
}: {
  rooms: CapturedRoom[];
  result: ImportResult;
  onScanMore(): void;
  onStartOver(): void;
}) {
  const insets = useSafeAreaInsets();

  const share = (text: string, name: string) => {
    shareJsonFile(name, text).catch((error: unknown) =>
      Alert.alert('Couldn’t share', error instanceof Error ? error.message : String(error))
    );
  };

  const issues = result.ok
    ? [
        ...result.notes.map((note) => note.message),
        ...(result.validation.ok ? [] : result.validation.errors.map((issue) => issue.message)),
        ...result.validation.warnings.map((issue) => issue.message),
      ]
    : result.errors;

  return (
    <ScrollView contentContainerStyle={[styles.review, { paddingBottom: insets.bottom + 24 }]}>
      <Text style={uiStyles.title}>
        {result.ok ? 'Your floor plan is ready' : 'The scan couldn’t be turned into a plan'}
      </Text>
      {rooms.map((room, index) => (
        <View key={index} style={styles.roomRow}>
          <Text style={styles.roomName}>{room.name}</Text>
          <Text style={styles.roomDetail}>
            {floorArea(room.corners).toFixed(1)} m² · {room.corners.length} walls ·{' '}
            {room.ceilingHeight.toFixed(2)} m ceiling
          </Text>
        </View>
      ))}
      {issues.length > 0 ? (
        <View style={styles.notes}>
          {issues.map((message, index) => (
            <Text key={index} style={styles.note}>
              • {message}
            </Text>
          ))}
        </View>
      ) : null}
      <Text style={uiStyles.body}>
        Share the layout to open it in the web editor, where you can add doors, windows and devices.
      </Text>
      <View style={styles.actions}>
        {result.ok ? (
          <Button
            label="Share layout"
            onPress={() => share(serializeLayout(result.layout), 'home-layout.json')}
          />
        ) : null}
        <Button
          label="Share raw scan"
          kind="secondary"
          onPress={() => share(JSON.stringify(buildScan(rooms), null, 2), 'room-scan.json')}
        />
        <Button label="Scan another room" kind="secondary" onPress={onScanMore} />
        <Button
          label="Start over"
          kind="secondary"
          onPress={() =>
            Alert.alert('Start over?', 'The rooms you scanned will be lost.', [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Start over', style: 'destructive', onPress: onStartOver },
            ])
          }
        />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  review: { padding: 24, gap: 12 },
  roomRow: { paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: '#ccc' },
  roomName: { fontSize: 16, fontWeight: '600' },
  roomDetail: { fontSize: 14, color: '#555' },
  notes: { backgroundColor: '#fef9c3', padding: 12, borderRadius: 8, gap: 4 },
  note: { fontSize: 14, color: '#713f12' },
  actions: { gap: 8 },
});
