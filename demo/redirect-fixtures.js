"use strict";

document.getElementById("popupButton").addEventListener("click", () => {
  const popup = window.open("https://doubleclick.net/offer", "_blank");
  document.getElementById("result").textContent = popup === null
    ? "Pass: the scripted ad popup was rejected."
    : "Fail: the scripted ad popup was opened.";
});
