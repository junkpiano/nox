/**
 * Full-screen pictures, with pinch to zoom.
 *
 * Written against `PanResponder` and the core `Animated`, with no new
 * dependency. The obvious choice would be a gesture library, and the obvious
 * gesture library pulls react-native-reanimated - which is exactly what took
 * this project's build down once already, when expo-router dragged in
 * reanimated 4.6 and its worklets runtime landed outside the range
 * expo-modules-core declares. Two hundred lines here are cheaper than that
 * again.
 *
 * The interactions are the ones people try without being told: pinch to zoom,
 * drag to move while zoomed, double-tap to toggle, tap to close, drag sideways
 * for the next picture, drag down to put it away, and arrows when a post
 * carried more than one picture.
 *
 * A drag is answered while the finger is still down - the picture moves with
 * it, and on the way down the ground fades so what is behind is already
 * visible before you let go. A gesture that only reports its verdict at the
 * end is one you have to learn; this one shows the way out as you take it.
 */

import { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Dimensions,
  Modal,
  PanResponder,
  type PanResponderInstance,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

const MAX_SCALE = 4;
const DOUBLE_TAP_SCALE = 2.5;
/** Two taps further apart than this are two taps, not a double tap. */
const DOUBLE_TAP_MS = 280;
/** Past a quarter of the screen, a sideways drag means the next picture. */
const SWIPE_COMMIT_RATIO = 0.25;
/** Or a flick, which is the same intention with less distance. */
const FLICK_VELOCITY = 0.35;
/** How far down the picture goes before letting go puts it away. */
const DISMISS_DISTANCE = 110;
const DISMISS_VELOCITY = 0.8;
/** The ground is fully faded by the time the picture is this far down. */
const DISMISS_FADE_DISTANCE = 320;
/** A drag has to mean one axis or the other before either answers it. */
const AXIS_LOCK = 8;

type Gesture = 'undecided' | 'pinch' | 'pan' | 'swipe' | 'dismiss';

function distance(touches: Array<{ pageX: number; pageY: number }>): number {
  const [a, b] = touches;
  if (!a || !b) {
    return 0;
  }
  return Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY);
}

export interface ImageViewerProps {
  urls: string[];
  /** Which one was tapped. Null closes the viewer. */
  index: number | null;
  onClose: () => void;
}

export default function ImageViewer({
  urls,
  index,
  onClose,
}: ImageViewerProps) {
  const [current, setCurrent] = useState<number>(index ?? 0);

  const scale = useRef(new Animated.Value(1)).current;
  const translateX = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(0)).current;

  // Kept apart from the pan above, which belongs to a zoomed picture: these
  // two carry the unzoomed gestures, so the fade can be read off the drag
  // without a zoomed pan dimming the screen.
  const swipeX = useRef(new Animated.Value(0)).current;
  const dismissY = useRef(new Animated.Value(0)).current;
  const backdrop = dismissY.interpolate({
    inputRange: [-DISMISS_FADE_DISTANCE, 0, DISMISS_FADE_DISTANCE],
    outputRange: [0, 1, 0],
    extrapolate: 'clamp',
  });

  // Read back synchronously inside the responder, which cannot await a
  // listener. `Animated.Value` has no public getter, so the last committed
  // values are kept alongside.
  const committed = useRef({ scale: 1, x: 0, y: 0 });
  const gestureStart = useRef({ distance: 0, scale: 1, x: 0, y: 0 });
  const lastTap = useRef(0);
  const gesture = useRef<Gesture>('undecided');
  // Each opening is its own session, so a throw still in the air cannot close
  // the picture that opened after it.
  const session = useRef(0);
  // The responder is built once, so it reads the picture count and the screen
  // through a ref rather than closing over the first render's values.
  const frame = useRef({ width: 0, height: 0, count: 0 });

  useEffect((): void => {
    if (index !== null) {
      setCurrent(index);
      // A viewer opened again starts where it opens, not where the last
      // gesture left it: the values outlive the closed state. Opening is
      // where they are put back, because a picture thrown off the screen has
      // to stay thrown until it is gone.
      session.current += 1;
      swipeX.setValue(0);
      dismissY.setValue(0);
      scale.setValue(1);
      translateX.setValue(0);
      translateY.setValue(0);
      committed.current = { scale: 1, x: 0, y: 0 };
    }
  }, [index, swipeX, dismissY, scale, translateX, translateY]);

  const reset = (): void => {
    committed.current = { scale: 1, x: 0, y: 0 };
    Animated.parallel([
      Animated.spring(scale, { toValue: 1, useNativeDriver: true }),
      Animated.spring(translateX, { toValue: 0, useNativeDriver: true }),
      Animated.spring(translateY, { toValue: 0, useNativeDriver: true }),
    ]).start();
  };

  const zoomTo = (next: number): void => {
    committed.current = { scale: next, x: 0, y: 0 };
    Animated.parallel([
      Animated.spring(scale, { toValue: next, useNativeDriver: true }),
      Animated.spring(translateX, { toValue: 0, useNativeDriver: true }),
      Animated.spring(translateY, { toValue: 0, useNativeDriver: true }),
    ]).start();
  };

  const show = (next: number): void => {
    reset();
    setCurrent(next);
  };

  /**
   * Carry the picture the rest of the way out and bring the next one in from
   * the edge the finger was heading for. One picture is on screen at a time,
   * so the arrival is the same value swung to the far side and released.
   */
  const slideTo = (direction: 1 | -1, width: number, count: number): void => {
    Animated.timing(swipeX, {
      toValue: -direction * width,
      duration: 140,
      useNativeDriver: true,
    }).start(({ finished }): void => {
      // A drag, a close or a reopen stops this animation by writing the value
      // from under it. Advancing anyway would show a picture nobody asked for.
      if (!finished) {
        return;
      }
      reset();
      setCurrent(
        (shown: number): number => (shown + direction + count) % count,
      );
      swipeX.setValue(direction * width);
      Animated.spring(swipeX, {
        toValue: 0,
        bounciness: 0,
        useNativeDriver: true,
      }).start();
    });
  };

  /**
   * Put a half-finished drag back. A second finger arriving means the gesture
   * became a pinch, and a terminated responder means the system took the
   * touch: in both cases nothing is left to answer the drag, and a picture
   * left off-centre with the ground half faded is an app that looks stuck.
   */
  const settleDrag = (): void => {
    gesture.current = 'undecided';
    Animated.parallel([
      Animated.spring(swipeX, {
        toValue: 0,
        bounciness: 0,
        useNativeDriver: true,
      }),
      Animated.spring(dismissY, {
        toValue: 0,
        bounciness: 0,
        useNativeDriver: true,
      }),
    ]).start();
  };

  const close = (): void => {
    onClose();
  };

  /**
   * Let a picture that was thrown go on falling. Putting it back to the middle
   * first showed it whole for a moment before the screen faded, which reads as
   * the app catching it and then dropping it anyway. It leaves the way it was
   * sent, and the ground is already gone by the time it is off the screen.
   */
  const throwOut = (direction: 1 | -1, height: number): void => {
    const thrown: number = session.current;
    Animated.timing(dismissY, {
      toValue: direction * height,
      duration: 160,
      useNativeDriver: true,
    }).start((): void => {
      // Interrupted counts as dismissed - the picture is off the screen
      // either way - unless another one has opened since, which is the one
      // case where closing would take away something nobody threw.
      if (session.current === thrown) {
        onClose();
      }
    });
  };

  const responder: PanResponderInstance = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: (): boolean => true,
      onMoveShouldSetPanResponder: (_event, move): boolean =>
        // A zoomed picture claims the drag; an unzoomed one lets a tap
        // through so closing still works.
        committed.current.scale > 1 ||
        Math.abs(move.dx) > 4 ||
        Math.abs(move.dy) > 4,

      onPanResponderGrant: (event): void => {
        const touches = event.nativeEvent.touches;
        gesture.current = touches.length >= 2 ? 'pinch' : 'undecided';
        gestureStart.current = {
          distance: touches.length >= 2 ? distance(touches) : 0,
          scale: committed.current.scale,
          x: committed.current.x,
          y: committed.current.y,
        };
      },

      onPanResponderMove: (event, move): void => {
        const touches = event.nativeEvent.touches;

        if (touches.length >= 2) {
          if (gesture.current === 'swipe' || gesture.current === 'dismiss') {
            settleDrag();
          }
          gesture.current = 'pinch';
          const started: number = gestureStart.current.distance;
          const now: number = distance(touches);
          if (started > 0 && now > 0) {
            const next: number = Math.min(
              MAX_SCALE,
              Math.max(1, (gestureStart.current.scale * now) / started),
            );
            committed.current.scale = next;
            scale.setValue(next);
          }
          return;
        }

        if (committed.current.scale > 1) {
          gesture.current = 'pan';
          const x: number = gestureStart.current.x + move.dx;
          const y: number = gestureStart.current.y + move.dy;
          committed.current.x = x;
          committed.current.y = y;
          translateX.setValue(x);
          translateY.setValue(y);
          return;
        }

        // Unzoomed, the first decisive direction owns the rest of the drag.
        // Without the lock a picture would slide sideways and downwards at
        // once and answer to whichever axis the finger last favoured.
        if (gesture.current === 'undecided') {
          if (Math.abs(move.dx) > AXIS_LOCK || Math.abs(move.dy) > AXIS_LOCK) {
            gesture.current =
              Math.abs(move.dx) > Math.abs(move.dy) ? 'swipe' : 'dismiss';
          } else {
            return;
          }
        }

        if (gesture.current === 'swipe') {
          swipeX.setValue(move.dx);
        } else if (gesture.current === 'dismiss') {
          dismissY.setValue(move.dy);
        }
      },

      onPanResponderRelease: (_event, move): void => {
        const { width, height, count } = frame.current;

        if (gesture.current === 'swipe') {
          gesture.current = 'undecided';
          const committedSwipe: boolean =
            Math.abs(move.dx) > width * SWIPE_COMMIT_RATIO ||
            Math.abs(move.vx) > FLICK_VELOCITY;
          if (committedSwipe && count > 1) {
            slideTo(move.dx < 0 ? 1 : -1, width, count);
          } else {
            // A single picture has nowhere to go, and a drag that stopped
            // short said so: it returns rather than reporting an error.
            Animated.spring(swipeX, {
              toValue: 0,
              bounciness: 0,
              useNativeDriver: true,
            }).start();
          }
          return;
        }

        if (gesture.current === 'dismiss') {
          gesture.current = 'undecided';
          const letGo: boolean =
            Math.abs(move.dy) > DISMISS_DISTANCE ||
            Math.abs(move.vy) > DISMISS_VELOCITY;
          if (letGo) {
            throwOut(move.dy < 0 ? -1 : 1, height);
          } else {
            Animated.spring(dismissY, {
              toValue: 0,
              bounciness: 0,
              useNativeDriver: true,
            }).start();
          }
          return;
        }

        gesture.current = 'undecided';
        const moved: boolean = Math.abs(move.dx) > 6 || Math.abs(move.dy) > 6;

        if (!moved) {
          const now: number = Date.now();
          if (now - lastTap.current < DOUBLE_TAP_MS) {
            lastTap.current = 0;
            if (committed.current.scale > 1) {
              reset();
            } else {
              zoomTo(DOUBLE_TAP_SCALE);
            }
            return;
          }
          lastTap.current = now;
          // A single tap closes, but only from the unzoomed state: tapping
          // while zoomed in is how you miss the picture you were looking at.
          if (committed.current.scale <= 1) {
            setTimeout((): void => {
              if (lastTap.current !== 0) {
                onClose();
              }
            }, DOUBLE_TAP_MS);
          }
          return;
        }

        if (committed.current.scale <= 1) {
          reset();
        }
      },

      onPanResponderTerminate: (): void => {
        settleDrag();
      },
    }),
  ).current;

  if (index === null) {
    return null;
  }

  const url: string | undefined = urls[current];
  const { width, height } = Dimensions.get('window');
  frame.current = { width, height, count: urls.length };

  return (
    <Modal
      visible
      transparent
      animationType="fade"
      onRequestClose={close}
      statusBarTranslucent
    >
      <Animated.View
        style={[styles.backdrop, { opacity: backdrop }]}
        pointerEvents="none"
      />
      <View style={styles.screen} {...responder.panHandlers}>
        {url ? (
          <Animated.Image
            source={{ uri: url }}
            resizeMode="contain"
            style={[
              { width, height },
              {
                transform: [
                  { translateX },
                  { translateY },
                  { translateX: swipeX },
                  { translateY: dismissY },
                  { scale },
                ],
              },
            ]}
          />
        ) : null}
      </View>

      <Animated.View
        style={[styles.chrome, { opacity: backdrop }]}
        pointerEvents="box-none"
      >
        <Pressable onPress={close} hitSlop={16} style={styles.close}>
          <Text style={styles.closeText}>✕</Text>
        </Pressable>

        {urls.length > 1 ? (
          <View style={styles.pager} pointerEvents="box-none">
            <Pressable
              onPress={(): void =>
                show((current - 1 + urls.length) % urls.length)
              }
              hitSlop={16}
              style={styles.arrow}
            >
              <Text style={styles.arrowText}>‹</Text>
            </Pressable>
            <Text style={styles.count}>
              {current + 1} / {urls.length}
            </Text>
            <Pressable
              onPress={(): void => show((current + 1) % urls.length)}
              hitSlop={16}
              style={styles.arrow}
            >
              <Text style={styles.arrowText}>›</Text>
            </Pressable>
          </View>
        ) : null}
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  // The ground is its own layer so a drag downwards can fade it and reveal the
  // timeline underneath, which is what says the picture is being put away.
  backdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#000',
  },
  screen: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chrome: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'space-between',
  },
  close: { alignSelf: 'flex-end', padding: 20, marginTop: 28 },
  closeText: { color: '#fff', fontSize: 26, fontWeight: '300' },
  pager: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 24,
    paddingBottom: 40,
  },
  arrow: { paddingHorizontal: 16, paddingVertical: 8 },
  arrowText: { color: '#fff', fontSize: 34, fontWeight: '300' },
  count: { color: '#fff', fontSize: 14 },
});
