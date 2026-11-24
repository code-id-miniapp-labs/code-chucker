Page({
  data: {
    count: 0,
  },
  handleIncrement() {
    this.setData({
      count: this.data.count + 1,
    });
  },
});
