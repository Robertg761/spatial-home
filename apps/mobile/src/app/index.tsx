import { Link } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { Platform, StyleSheet, Text, View } from 'react-native';

export default function HomeScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Spatial Home</Text>
      {Platform.OS === 'android' ? (
        <Link href="/scan" style={styles.link}>
          Scan rooms
        </Link>
      ) : (
        <Text>Room scanning on iPhone is on its way.</Text>
      )}
      <StatusBar style="auto" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
  },
  title: {
    fontSize: 24,
    fontWeight: '600',
  },
  link: {
    backgroundColor: '#2563eb',
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 10,
    overflow: 'hidden',
  },
});
