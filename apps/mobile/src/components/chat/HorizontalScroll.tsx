import { ScrollView, View, type ScrollViewProps } from 'react-native'

const takeTouch = () => true

// A row that scrolls sideways inside a message. On iOS a scroll view stops scrolling while one of its
// ancestors holds the touch, and the bubble's tap that brings the time up (MessageTimeReveal) would
// hold it: the content takes the touch first, so the row scrolls and a swipe across it stays a swipe.
export function HorizontalScroll({ children, ...props }: ScrollViewProps) {
    return (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} {...props}>
            <View onStartShouldSetResponder={takeTouch}>{children}</View>
        </ScrollView>
    )
}
