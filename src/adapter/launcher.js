// Only presentation changes here; the original launcher and its drag/click handlers stay intact.
export function setLauncherVisible(launcher, visible = true) {
    if (!launcher) return;
    launcher.hidden = !visible;
    // The original stylesheet sets display explicitly, so hidden alone is insufficient.
    if (visible) launcher.style.removeProperty('display');
    else launcher.style.setProperty('display', 'none', 'important');
}
