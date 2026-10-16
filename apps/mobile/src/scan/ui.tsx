// The buttons and centred messages the scan screens share.

import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

export function Centered({
  title,
  body,
  children,
}: {
  title: string;
  body?: string;
  children?: ReactNode;
}) {
  return (
    <View style={uiStyles.centered}>
      <Text style={uiStyles.title}>{title}</Text>
      {body ? <Text style={uiStyles.body}>{body}</Text> : null}
      {children}
    </View>
  );
}

export function Button({
  label,
  onPress,
  kind = 'primary',
  disabled = false,
  grow = false,
}: {
  label: string;
  onPress(): void;
  kind?: 'primary' | 'secondary';
  disabled?: boolean;
  grow?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        uiStyles.button,
        kind === 'secondary' && uiStyles.buttonSecondary,
        grow && uiStyles.grow,
        disabled && uiStyles.buttonDisabled,
        pressed && uiStyles.buttonPressed,
      ]}
    >
      <Text style={[uiStyles.buttonLabel, kind === 'secondary' && uiStyles.buttonLabelSecondary]}>
        {label}
      </Text>
    </Pressable>
  );
}

export const uiStyles = StyleSheet.create({
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 },
  title: { fontSize: 20, fontWeight: '600', textAlign: 'center' },
  body: { fontSize: 15, color: '#444', textAlign: 'center', lineHeight: 21 },
  grow: { flex: 1 },
  button: {
    backgroundColor: '#2563eb',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
  },
  buttonSecondary: { backgroundColor: '#e5e7eb' },
  buttonDisabled: { opacity: 0.4 },
  buttonPressed: { opacity: 0.7 },
  buttonLabel: { color: '#fff', fontSize: 16, fontWeight: '600' },
  buttonLabelSecondary: { color: '#111' },
});
