chrome.action.onClicked.addListener((tab) => {
    chrome.sidePanel.setOptions({
      path: 'js/index.html',
      enabled: true
    });

    chrome.sidePanel.open({ windowId: tab.windowId });
  });

  export{}