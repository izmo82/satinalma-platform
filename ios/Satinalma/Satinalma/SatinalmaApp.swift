import SwiftUI

@main
struct SatinalmaApp: App {
    @State private var session = SessionStore()
    @State private var drafts = DraftStore()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(session)
                .environment(drafts)
        }
    }
}
