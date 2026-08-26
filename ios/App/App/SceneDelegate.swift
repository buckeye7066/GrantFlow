import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene,
               willConnectTo session: UISceneSession,
               options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        // When UISceneStoryboardFile is present, UIKit has already created the
        // storyboard window and its CAPBridgeViewController. Preserve that
        // initialized bridge; construct the same root only as a fallback for a
        // scene connection that arrives without the storyboard-owned window.
        if window == nil {
            let appWindow = UIWindow(windowScene: windowScene)
            appWindow.rootViewController = CAPBridgeViewController()
            window = appWindow
        }
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(
            scene,
            willConnectTo: session,
            options: connectionOptions
        )
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
